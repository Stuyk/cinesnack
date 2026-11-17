import {
  app,
  shell,
  BrowserWindow,
  protocol,
  ipcMain,
  dialog,
  nativeImage,
  screen,
  session,
  desktopCapturer,
  globalShortcut,
  Menu,
  Notification
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { probe, warmup } from './ffmpeg'
import { encodeToFit, outputPathFor } from './encoder'
import { copyFileToClipboard } from './clipboard'
import { thumbnails, makePreviewProxy, cleanupPreviews } from './media'
import {
  Recorder,
  focusedSource,
  windowBeneath,
  type CapturePatch,
  listSources,
  locateDisplay,
  recordingSupport
} from './recorder'
import { Keybindings } from './keybindings'
import { AppTray, type AppCommand } from './tray'
import { buildAppMenu } from './menu'
import { prettyAccel, type CommandId, type UiState } from '../shared/commands'
import type {
  CaptureSource,
  ExportRequest,
  ExportResult,
  ProgressEvent,
  RecordOptions,
  RecordResult,
  RecordState,
  SourcesResult
} from '../shared/types'

const APP_TITLE = 'CineSnack'
const WIDGET_TITLE = 'CineSnack Recorder'

// One running copy: relaunching (taskbar task, dock, "Open with") talks to the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// macOS: let Chromium's ScreenCaptureKit path provide system-audio loopback.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'
  )
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

const VIDEO_EXTENSIONS = [
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'wmv',
  'flv',
  'ts',
  'mts',
  'm2ts',
  'mpg',
  'mpeg',
  '3gp',
  'ogv',
  'gif'
]

let mainWindow: BrowserWindow | null = null
let exportAbort: AbortController | null = null
let previewAbort: AbortController | null = null
let widget: BrowserWindow | null = null
let sourceCache = new Map<string, CaptureSource>()
let tray: AppTray | null = null
let quitting = false
let toldAboutTray = false
let rendererReady = false
let pendingArgv: string[] = process.argv
let pendingCommand: CommandId | null = null
let captureSource: CaptureSource | null = null
let keys: Keybindings
let uiState: UiState = {
  hasFile: false,
  exporting: false,
  hasOutput: false,
  fps: 60,
  audio: true,
  audioAvailable: true,
  sizeIndex: 1,
  recordAudio: true,
  autoExport: false
}
let recPhase: RecordState['phase'] = 'idle'

const WIDGET_W = 340
const WIDGET_H = 48
const BG = '#0f1620'

function broadcast(channel: string, payload: unknown): void {
  for (const w of [mainWindow, widget]) {
    if (w && !w.isDestroyed()) {
      w.webContents.send(channel, payload)
    }
  }
}

function loadRenderer(win: BrowserWindow, hash?: string): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? `#${hash}` : ''))
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

function exportsFolder(): string {
  return path.join(app.getPath('videos'), 'CineSnack')
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

/** Hand a command to the editor window, opening it first when needed. */
function sendCommand(id: CommandId): void {
  if ((id === 'record' || id === 'record-focused' || id === 'open') && recorder.busy) {
    return
  }
  if (id === 'record-focused') {
    void recordFocused()
    return
  }
  showMain()
  if (rendererReady) {
    mainWindow?.webContents.send('app:command', id)
  } else {
    pendingCommand = id
  }
}

function refreshMenu(): void {
  Menu.setApplicationMenu(
    buildAppMenu(
      uiState,
      recPhase,
      {
        send: sendCommand,
        stopRecording: () => recorder.stop(),
        openExportsFolder: () => runCommand('folder'),
        quit: () => runCommand('quit')
      },
      keys.bindings
    )
  )
}

/** Push new shortcuts everywhere they're shown. */
function keysChanged(): void {
  refreshMenu()
  tray?.setBindings(keys.bindings)
  broadcast('keys:changed', keys.state)
}

/** Global shortcut pressed. Either recording key stops a running recording. */
function onGlobalKey(id: CommandId): void {
  if (recorder.busy) {
    recorder.stop()
    return
  }
  if (id === 'record-focused') {
    void recordFocused()
  } else if (id === 'record') {
    sendCommand('record')
  }
}

/** Start recording a source with the editor's current recording settings. */
async function startRecording(source: CaptureSource, opts: RecordOptions): Promise<boolean> {
  if (recorder.busy) {
    return false
  }
  sourceCache.set(source.id, source)
  await openWidget(source)
  if (mainWindow?.isVisible()) {
    mainWindow.minimize()
  }
  void recorder.start(source, opts)
  return true
}

/** Record whatever window has focus right now. Falls back to the picker when that's us. */
async function recordFocused(): Promise<void> {
  if (recorder.busy) {
    return
  }
  const support = recordingSupport()
  if (!support.ok) {
    sendCommand('record')
    return
  }
  const found = await focusedSource(APP_TITLE, WIDGET_TITLE).catch(() => null)
  if (!found || found.own) {
    sendCommand('record')
    return
  }
  await startRecording(found.source, { audio: uiState.recordAudio, fps: uiState.fps })
}

/** Entry point for tray, dock, jump list and command-line actions. */
function runCommand(c: AppCommand): void {
  switch (c) {
    case 'record':
    case 'open':
      sendCommand(c)
      return
    case 'record-focused':
      void recordFocused()
      return
    case 'show':
      if (mainWindow?.isVisible() && mainWindow.isFocused() && process.platform !== 'linux') {
        mainWindow.hide()
      } else {
        showMain()
      }
      return
    case 'stop':
      recorder.stop()
      return
    case 'folder':
      fs.mkdirSync(exportsFolder(), { recursive: true })
      void shell.openPath(exportsFolder())
      return
    case 'quit':
      quitting = true
      app.quit()
  }
}

/** --record / --open flags, or a video file path ("Open with CineSnack"). */
function handleArgv(argv: string[]): void {
  if (!rendererReady) {
    pendingArgv = argv
    return
  }
  const args = argv.slice(app.isPackaged ? 1 : 2)
  if (args.includes('--record')) {
    return runCommand('record')
  }
  if (args.includes('--open')) {
    return runCommand('open')
  }
  const file = args.find(
    (a) =>
      !a.startsWith('-') &&
      VIDEO_EXTENSIONS.includes(path.extname(a).slice(1).toLowerCase()) &&
      fs.existsSync(a)
  )
  if (file) {
    showMain()
    mainWindow?.webContents.send('app:open-path', path.resolve(file))
  }
}

async function openWidget(source: CaptureSource): Promise<void> {
  const fallback = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()
  const display = await locateDisplay(source, fallback)
  // Remember it so the screen-region math in the recorder agrees with the widget.
  source.displayId ??= String(display.id)
  captureSource = source
  const M = 16
  widget = new BrowserWindow({
    title: WIDGET_TITLE,
    width: WIDGET_W,
    height: WIDGET_H,
    // Bottom-right of the display being recorded. It stays there, visible, for the whole recording.
    x: display.workArea.x + display.workArea.width - WIDGET_W - M,
    y: display.workArea.y + display.workArea.height - WIDGET_H - M,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: BG,
    show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false }
  })
  widget.setAlwaysOnTop(true, 'screen-saver')
  // Windows 10 2004+ and macOS leave the window out of screen captures. X11 has no such
  // thing; prepareCapture() handles it there.
  widget.setContentProtection(true)
  widget.on('ready-to-show', () => widget?.showInactive())
  widget.on('page-title-updated', (e) => e.preventDefault())
  widget.on('closed', () => (widget = null))
  loadRenderer(widget, 'widget')
}

/** X11 id of an Electron window (Linux), as a decimal string. */
function xid(win: BrowserWindow | null): string | null {
  if (!win || win.isDestroyed()) {
    return null
  }
  const h = win.getNativeWindowHandle()
  return h.length >= 4 ? String(h.readUInt32LE(0)) : null
}

/**
 * Called right before ffmpeg starts grabbing. The widget stays where it is and stays visible;
 * this only makes sure it doesn't end up in the video:
 * - Windows: content protection already removes it from every capture.
 * - macOS: content protection (window sharing off) keeps it out of the screen capture.
 * - Linux, window recording: a single-window grab never contains other windows. Nothing to do.
 * - Linux, screen recording: refill the widget's rectangle from the window underneath it.
 */
async function prepareCapture(): Promise<CapturePatch | null> {
  if (!widget || widget.isDestroyed() || process.platform !== 'linux' || !captureSource) {
    return null
  }
  if (captureSource.kind !== 'screen') {
    return null
  }
  const display = screen.getAllDisplays().find((d) => String(d.id) === captureSource?.displayId)
  if (!display) {
    return null
  }
  // The patch is fixed for the whole recording, so the widget can't be dragged around.
  widget.setMovable(false)
  const s = display.scaleFactor
  const w = widget.getBounds()
  // One pixel of margin covers any anti-aliasing at the edges.
  const abs = {
    x: Math.floor(w.x * s) - 1,
    y: Math.floor(w.y * s) - 1,
    width: Math.ceil(w.width * s) + 2,
    height: Math.ceil(w.height * s) + 2
  }
  const rel = {
    x: Math.max(0, abs.x - Math.round(display.bounds.x * s)),
    y: Math.max(0, abs.y - Math.round(display.bounds.y * s)),
    width: abs.width,
    height: abs.height
  }
  const own = [xid(widget), xid(mainWindow)].filter((v): v is string => !!v)
  const under = await windowBeneath(abs, own).catch(() => null)
  if (under) {
    return {
      kind: 'window',
      windowId: under.id,
      ...rel,
      srcX: abs.x - under.bounds.x,
      srcY: abs.y - under.bounds.y
    }
  }
  return { kind: 'delogo', ...rel }
}

const recorder = new Recorder({
  onState: (s: RecordState) => {
    broadcast('rec:state', s)
    tray?.update(s)
    if (s.phase !== recPhase) {
      recPhase = s.phase
      refreshMenu()
    }
  },
  beforeCapture: prepareCapture,
  requestRendererAudio: (on) => broadcast('rec:audio-capture', on),
  onDone: (r: RecordResult) => {
    widget?.close()
    // Auto-export works in the background: stay out of the way unless something went wrong.
    if (!(uiState.autoExport && r.ok)) {
      showMain()
    }
    broadcast('rec:done', r)
  }
})

function notify(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon, silent: false }).show()
  }
}

function sendProgress(e: ProgressEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress', e)
  }
}

function mimeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.webm':
      return 'video/webm'
    case '.ogv':
      return 'video/ogg'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    default:
      return 'video/mp4'
  }
}

/** media://local/?p=<encoded absolute path>  — streamed with Range support for seeking. */
function handleMedia(request: Request): Response {
  const filePath = new URL(request.url).searchParams.get('p')
  if (!filePath || !fs.existsSync(filePath)) {
    return new Response('Not Found', { status: 404 })
  }

  const size = fs.statSync(filePath).size
  const range = request.headers.get('range')
  const type = mimeFor(filePath)
  if (!range) {
    return new Response(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, {
      status: 200,
      headers: { 'Content-Length': String(size), 'Content-Type': type, 'Accept-Ranges': 'bytes' }
    })
  }
  const [s, e] = range.replace(/bytes=/, '').split('-')
  const start = parseInt(s, 10) || 0
  const end = e ? Math.min(parseInt(e, 10), size - 1) : size - 1
  return new Response(
    Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream,
    {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': type
      }
    }
  )
}

function registerIpc(): void {
  ipcMain.handle('dialog:open', async () => {
    if (!mainWindow) {
      return null
    }
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a video',
      properties: ['openFile'],
      filters: [
        { name: 'Videos', extensions: VIDEO_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle('video:probe', (_e, filePath: string) => probe(filePath))

  ipcMain.handle('video:thumbs', (_e, filePath: string, durationSec: number) =>
    thumbnails(filePath, durationSec)
  )

  ipcMain.handle('video:proxy', async (_e, filePath: string, durationSec: number) => {
    previewAbort?.abort()
    const ctrl = (previewAbort = new AbortController())
    try {
      return await makePreviewProxy(
        filePath,
        durationSec,
        (p) => sendProgress({ kind: 'preview', progress: p, label: 'Preparing preview' }),
        ctrl.signal
      )
    } catch {
      return null
    } finally {
      if (previewAbort === ctrl) {
        previewAbort = null
      }
    }
  })

  ipcMain.handle('export:start', async (_e, req: ExportRequest): Promise<ExportResult> => {
    exportAbort?.abort()
    const ctrl = (exportAbort = new AbortController())
    try {
      const info = await probe(req.input)
      const output = await outputPathFor(req.input)
      const bytes = await encodeToFit(req, info, output, {
        signal: ctrl.signal,
        onProgress: (progress, label) => sendProgress({ kind: 'export', progress, label })
      })
      const copied = await copyFileToClipboard(output)
      if (req.auto) {
        notify(
          copied ? 'Clip copied to the clipboard' : 'Clip exported',
          copied
            ? `${(bytes / 1e6).toFixed(1)} MB, ready to paste.`
            : `${(bytes / 1e6).toFixed(1)} MB, saved to ${path.basename(output)}. Copying failed, so drag it from CineSnack.`
        )
        if (!copied) {
          showMain()
        }
      }
      return { ok: true, outputPath: output, bytes, copied }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (req.auto && !ctrl.signal.aborted) {
        notify('Auto-export failed', msg.split('\n')[0])
        showMain()
      }
      return { ok: false, error: ctrl.signal.aborted ? 'cancelled' : msg }
    } finally {
      if (exportAbort === ctrl) {
        exportAbort = null
      }
    }
  })

  ipcMain.handle('export:cancel', () => {
    exportAbort?.abort()
    return true
  })

  ipcMain.handle('rec:sources', async (): Promise<SourcesResult> => {
    const support = recordingSupport()
    if (!support.ok) {
      return { ok: false, reason: support.reason, sources: [] }
    }
    try {
      const sources = await listSources(APP_TITLE, WIDGET_TITLE)
      sourceCache = new Map(sources.map((s) => [s.id, s]))
      return { ok: true, sources }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: `Could not list screens/windows: ${reason}`, sources: [] }
    }
  })

  ipcMain.handle('rec:start', async (_e, sourceId: string, opts: RecordOptions) => {
    const source = sourceCache.get(sourceId)
    return source ? startRecording(source, opts) : false
  })
  ipcMain.on('rec:stop', () => recorder.stop())
  ipcMain.on('rec:cancel', () => recorder.cancel())
  ipcMain.on('rec:audio', (_e, chunk: Uint8Array) => recorder.pushAudio(chunk))

  ipcMain.on('ui:state', (_e, next: UiState) => {
    uiState = next
    refreshMenu()
  })
  ipcMain.handle('app:warmup', () => warmup())
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    keys: keys.state
  }))
  ipcMain.handle('keys:set', (_e, id: CommandId, accel: string | null) => {
    const res = keys.set(id, accel)
    keysChanged()
    return { ...res, keys: keys.state }
  })
  ipcMain.handle('keys:reset', () => {
    keys.resetAll()
    keysChanged()
    return keys.state
  })
  // While the shortcut editor listens for keys, globals must not fire (and steal the keypress).
  ipcMain.on('keys:capturing', (_e, on: boolean) => {
    if (on) {
      globalShortcut.unregisterAll()
    } else {
      keys.registerGlobals()
    }
  })

  ipcMain.on('app:show', () => showMain())

  ipcMain.handle('file:copy', (_e, filePath: string) => copyFileToClipboard(filePath))
  ipcMain.on('file:reveal', (_e, filePath: string) => shell.showItemInFolder(filePath))
  ipcMain.on('file:drag', (e, filePath: string) => {
    e.sender.startDrag({
      file: filePath,
      icon: nativeImage.createFromPath(icon).resize({ width: 64, height: 64 })
    })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 600,
    // Visible straight away; the page shows its own loading screen while things warm up.
    show: true,
    backgroundColor: BG,
    icon,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Keeps loopback audio capture running while minimized during a recording.
      backgroundThrottling: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // Dropping a file outside the drop zone must not navigate the window away.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true
    handleArgv(pendingArgv)
    pendingArgv = []
    if (pendingCommand) {
      mainWindow?.webContents.send('app:command', pendingCommand)
      pendingCommand = null
    }
  })

  // With a tray icon, closing the window keeps CineSnack running in the background.
  mainWindow.on('close', (e) => {
    if (quitting || !tray) {
      return
    }
    e.preventDefault()
    mainWindow?.hide()
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true
      new Notification({
        title: 'CineSnack is still running',
        body: keys.bindings['record-focused']
          ? `Press ${prettyAccel(keys.bindings['record-focused'], process.platform === 'darwin')} to record the window you're in, or use the tray icon.`
          : 'Use the tray icon to record, open a video, or quit.',
        icon
      }).show()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  loadRenderer(mainWindow)
}

app.whenReady().then(() => {
  // Start ffmpeg now so it's warm by the time the page asks.
  void warmup()
  electronApp.setAppUserModelId('com.stuyk.cinesnack')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  protocol.handle('media', (req) => {
    try {
      return handleMedia(req)
    } catch (err) {
      console.error('[media]', err)
      return new Response('Error', { status: 500 })
    }
  })
  // Windows/macOS system audio: Chromium loopback via getDisplayMedia (video track is discarded).
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}))
  })
  keys = new Keybindings(onGlobalKey)
  const refused = keys.registerGlobals()
  if (refused.length) {
    console.warn('[keys] global shortcuts refused by the OS:', refused)
  }
  registerIpc()
  refreshMenu()
  createWindow()

  try {
    tray = new AppTray(icon, runCommand, keys.bindings)
  } catch (err) {
    console.warn('[tray] unavailable, closing the window will quit:', err)
  }
  // Windows taskbar right-click (jump list). Only meaningful for the installed exe.
  if (process.platform === 'win32' && app.isPackaged) {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: '--record',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'Record screen',
        description: 'Pick a screen or window to record'
      },
      {
        program: process.execPath,
        arguments: '--open',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'Open video',
        description: 'Choose a video to trim and shrink'
      }
    ])
  }
  app.on('second-instance', (_e, argv) => {
    showMain()
    handleArgv(argv)
  })
  app.on('activate', () => showMain())
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', () => {
  quitting = true
  tray?.destroy()
  recorder.cancel()
  exportAbort?.abort()
  previewAbort?.abort()
  void cleanupPreviews()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
