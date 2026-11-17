import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { app, desktopCapturer, screen } from 'electron'
import { getFfmpegPath } from './ffmpeg'
import type { CaptureSource, RecordOptions, RecordResult, RecordState } from '../shared/types'

export const MAX_RECORD_SEC = 300
export const COUNTDOWN_SEC = 5

/** Raw PCM layout shared by every audio feed. */
const RATE = 48000
const CHANNELS = 2

interface Hooks {
  onState: (s: RecordState) => void
  onDone: (r: RecordResult) => void
  /** Win/mac: ask the renderer to start/stop streaming loopback PCM to us. */
  requestRendererAudio: (on: boolean) => void
  /**
   * Runs right before ffmpeg starts grabbing. May return a patch that hides the recording
   * widget from a full-screen X11 grab (see CapturePatch).
   */
  beforeCapture?: () => Promise<CapturePatch | null>
}

/**
 * X11 can't leave a window out of a screen grab, but a single-window grab only contains that
 * window's own pixels (the compositor keeps them, overlaps excluded). So the widget's rectangle
 * is refilled every frame from the window underneath it. All values in physical pixels.
 */
export type CapturePatch =
  | {
      kind: 'window'
      /** X11 id of the window under the widget. */
      windowId: string
      /** Widget rectangle inside the captured frame. */
      x: number
      y: number
      width: number
      height: number
      /** Same rectangle, relative to the window underneath. */
      srcX: number
      srcY: number
    }
  /** Nothing usable underneath: smudge the rectangle out with ffmpeg's delogo filter. */
  | { kind: 'delogo'; x: number; y: number; width: number; height: number }

const platform = process.platform

export function recordingSupport(): {
  ok: boolean
  reason?: string
  audio: 'parec' | 'renderer' | 'none'
} {
  if (platform === 'linux') {
    if (
      process.env.XDG_SESSION_TYPE === 'wayland' ||
      (!process.env.DISPLAY && process.env.WAYLAND_DISPLAY)
    ) {
      return {
        ok: false,
        reason: 'Screen recording needs an X11 session (Wayland is not supported yet).',
        audio: 'none'
      }
    }
    return { ok: true, audio: 'parec' }
  }
  return { ok: true, audio: 'renderer' }
}

/** Lists screens and windows, minus CineSnack's own (the editor title ends with the app name). */
export async function listSources(appTitle: string, widgetTitle: string): Promise<CaptureSource[]> {
  const types: ('screen' | 'window')[] = platform === 'darwin' ? ['screen'] : ['screen', 'window']
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: false
  })
  return sources
    .filter((s) => s.name.trim() && s.name !== widgetTitle && !s.name.endsWith(appTitle))
    .map((s) => ({
      id: s.id,
      name: s.id.startsWith('screen:') ? screenLabel(s.display_id, s.name) : s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      displayId: s.display_id || undefined
    }))
}

/** Run a command and resolve its stdout, or null on any failure. */
function run(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, out) =>
      resolve(err ? null : String(out))
    )
  })
}

/** Native id of the window that has keyboard focus right now (decimal string), or null. */
async function activeWindowId(): Promise<string | null> {
  if (platform === 'linux') {
    const out = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'])
    const hex = out?.match(/0x[0-9a-f]+/i)?.[0]
    const id = hex ? parseInt(hex, 16) : 0
    return id ? String(id) : null
  }
  if (platform === 'win32') {
    const script =
      'Add-Type -Name W -Namespace N -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'; [N.W]::GetForegroundWindow().ToInt64()'
    const out = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      5000
    )
    const id = out?.trim()
    return id && /^\d+$/.test(id) && id !== '0' ? id : null
  }
  return null
}

/**
 * The source to record for "record focused window". Windows/Linux: the focused window.
 * macOS (screens only) or when the window can't be identified: the screen under the cursor.
 * Returns null when the focused window is CineSnack itself, so the caller can show the picker.
 */
export async function focusedSource(
  appTitle: string,
  widgetTitle: string
): Promise<{ source: CaptureSource; own?: false } | { own: true } | null> {
  const sources = await listSources(appTitle, widgetTitle)
  const id = await activeWindowId()
  if (id) {
    const match = sources.find((s) => s.kind === 'window' && s.id.split(':')[1] === id)
    if (match) {
      return { source: match }
    }
    // Our own windows are filtered out of the list; tell the caller instead of guessing.
    const all = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 }
    })
    const own = all.find((s) => s.id.split(':')[1] === id)
    if (own && (own.name === widgetTitle || own.name.endsWith(appTitle))) {
      return { own: true }
    }
    if (platform === 'linux') {
      // Not in Chromium's list (some WMs report a frame window): x11grab can still grab it.
      const name = (await run('xprop', ['-id', id, '_NET_WM_NAME']))?.match(/= "(.*)"/)?.[1]
      return {
        source: {
          id: `window:${id}:0`,
          name: name || 'Focused window',
          kind: 'window',
          thumbnail: ''
        }
      }
    }
  }
  const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const scr = sources.find((s) => s.kind === 'screen' && s.displayId === String(cursor.id))
  return scr ? { source: scr } : null
}

function screenLabel(displayId: string, fallback: string): string {
  const displays = screen.getAllDisplays()
  const i = displays.findIndex((d) => String(d.id) === displayId)
  if (i === -1) {
    return fallback
  }
  const d = displays[i]
  const w = Math.round(d.bounds.width * d.scaleFactor)
  const h = Math.round(d.bounds.height * d.scaleFactor)
  return `${displays.length > 1 ? `Screen ${i + 1}` : 'Entire screen'} · ${w}×${h}`
}

function displayFor(source: CaptureSource): Electron.Display {
  const displays = screen.getAllDisplays()
  return displays.find((d) => String(d.id) === source.displayId) ?? screen.getPrimaryDisplay()
}

/** Absolute geometry of an X11 window in physical pixels, or null. */
async function xGeometry(xid: string): Promise<Electron.Rectangle | null> {
  const out = await run('xwininfo', ['-id', xid], 2000)
  if (!out) {
    return null
  }
  const num = (label: string): number => Number(out.match(new RegExp(`${label}:\\s*(-?\\d+)`))?.[1])
  const rect = {
    x: num('Absolute upper-left X'),
    y: num('Absolute upper-left Y'),
    width: num('Width'),
    height: num('Height')
  }
  return Object.values(rect).every(Number.isFinite) && out.includes('IsViewable') ? rect : null
}

/**
 * Topmost visible window (EWMH stacking order) that fully covers `rect`, skipping our own
 * windows. Includes the desktop window. Physical pixels, absolute coordinates.
 */
export async function windowBeneath(
  rect: Electron.Rectangle,
  exclude: string[]
): Promise<{ id: string; bounds: Electron.Rectangle } | null> {
  if (platform !== 'linux') {
    return null
  }
  const out = await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING'])
  const ids = (out?.match(/0x[0-9a-f]+/gi) ?? []).map((h) => String(parseInt(h, 16)))
  for (const id of ids.reverse()) {
    if (exclude.includes(id)) {
      continue
    }
    const b = await xGeometry(id)
    if (
      b &&
      b.x <= rect.x &&
      b.y <= rect.y &&
      b.x + b.width >= rect.x + rect.width &&
      b.y + b.height >= rect.y + rect.height
    ) {
      return { id, bounds: b }
    }
  }
  return null
}

/** Absolute window geometry in physical pixels (X11 only; null elsewhere or on failure). */
function windowBounds(source: CaptureSource): Promise<Electron.Rectangle | null> {
  if (platform !== 'linux' || source.kind !== 'window') {
    return Promise.resolve(null)
  }
  const xid = source.id.split(':')[1]
  return new Promise((resolve) => {
    execFile('xwininfo', ['-id', xid], { timeout: 2000 }, (err, out) => {
      if (err) {
        return resolve(null)
      }
      const num = (label: string): number =>
        Number(out.match(new RegExp(`${label}:\\s*(-?\\d+)`))?.[1])
      const rect = {
        x: num('Absolute upper-left X'),
        y: num('Absolute upper-left Y'),
        width: num('Width'),
        height: num('Height')
      }
      resolve(Object.values(rect).every(Number.isFinite) ? rect : null)
    })
  })
}

/**
 * Work out which display a source lives on. Screens carry a display_id; window sources do not,
 * so on X11 we ask for the window's real geometry and pick the display it overlaps most.
 * `fallback` is used when nothing better is known (e.g. a window on Windows).
 */
export async function locateDisplay(
  source: CaptureSource,
  fallback: Electron.Display
): Promise<Electron.Display> {
  const byId = screen.getAllDisplays().find((d) => String(d.id) === source.displayId)
  if (byId) {
    return byId
  }
  const b = await windowBounds(source)
  if (b) {
    const scale = screen.getPrimaryDisplay().scaleFactor || 1
    return screen.getDisplayMatching({
      x: Math.round(b.x / scale),
      y: Math.round(b.y / scale),
      width: Math.max(1, Math.round(b.width / scale)),
      height: Math.max(1, Math.round(b.height / scale))
    })
  }
  return fallback
}

/** ffmpeg input args for the chosen screen/window, per platform. */
function videoInputArgs(source: CaptureSource, fps: number): string[] {
  const common = ['-thread_queue_size', '1024', '-probesize', '32', '-analyzeduration', '0']
  const fr = ['-framerate', String(fps)]
  if (platform === 'linux') {
    const display = process.env.DISPLAY || ':0'
    if (source.kind === 'window') {
      const xid = source.id.split(':')[1]
      return [...common, '-f', 'x11grab', ...fr, '-window_id', xid, '-i', display]
    }
    const d = displayFor(source)
    const x = Math.round(d.bounds.x * d.scaleFactor)
    const y = Math.round(d.bounds.y * d.scaleFactor)
    const w = Math.round(d.bounds.width * d.scaleFactor)
    const h = Math.round(d.bounds.height * d.scaleFactor)
    return [
      ...common,
      '-f',
      'x11grab',
      ...fr,
      '-video_size',
      `${w}x${h}`,
      '-i',
      `${display}+${x},${y}`
    ]
  }
  if (platform === 'win32') {
    if (source.kind === 'window') {
      return [...common, '-f', 'gdigrab', ...fr, '-i', `title=${source.name}`]
    }
    const d = displayFor(source)
    const x = Math.round(d.bounds.x * d.scaleFactor)
    const y = Math.round(d.bounds.y * d.scaleFactor)
    const w = Math.round(d.bounds.width * d.scaleFactor)
    const h = Math.round(d.bounds.height * d.scaleFactor)
    return [
      ...common,
      '-f',
      'gdigrab',
      ...fr,
      '-offset_x',
      String(x),
      '-offset_y',
      String(y),
      '-video_size',
      `${w}x${h}`,
      '-i',
      'desktop'
    ]
  }
  // macOS avfoundation: screens are listed after cameras as "Capture screen N".
  const idx = screen.getAllDisplays().findIndex((d) => String(d.id) === source.displayId)
  return [
    ...common,
    '-f',
    'avfoundation',
    ...fr,
    '-capture_cursor',
    '1',
    '-i',
    `Capture screen ${Math.max(0, idx)}:none`
  ]
}

function timestampName(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `recording-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.mp4`
}

/**
 * Feeds raw s16le PCM into ffmpeg over a localhost socket. Audio that arrives before ffmpeg
 * connects is dropped so the first sample lines up with the first video frame.
 */
class AudioBridge {
  private server = net.createServer()
  private socket: net.Socket | null = null
  private parec: ChildProcess | null = null
  port = 0

  async listen(): Promise<void> {
    this.server.on('connection', (sock) => {
      this.socket?.destroy()
      this.socket = sock
      sock.on('error', () => {})
    })
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res))
    this.port = (this.server.address() as net.AddressInfo).port
  }

  write(chunk: Buffer): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(chunk)
    }
  }

  /** Linux: system output via the default sink's monitor (PulseAudio or PipeWire-pulse). */
  startParec(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('parec', [
        '--device=@DEFAULT_MONITOR@',
        '--format=s16le',
        `--rate=${RATE}`,
        `--channels=${CHANNELS}`,
        '--latency-msec=20',
        '--raw'
      ])
      this.parec = proc
      let settled = false
      proc.on('error', () => {
        if (!settled) {
          settled = true
          resolve(false)
        }
      })
      proc.stdout?.on('data', (c: Buffer) => {
        if (!settled) {
          settled = true
          resolve(true)
        }
        this.write(c)
      })
      proc.stderr?.on('data', () => {})
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve(proc.exitCode === null)
        }
      }, 1500)
    })
  }

  /** Close the socket so ffmpeg sees EOF on the audio input. */
  end(): void {
    this.parec?.kill()
    this.parec = null
    this.socket?.end()
  }

  close(): void {
    this.end()
    this.socket?.destroy()
    this.server.close()
  }
}

export class Recorder {
  private state: RecordState = {
    phase: 'idle',
    countdown: 0,
    elapsedSec: 0,
    maxSec: MAX_RECORD_SEC,
    audio: false
  }
  private ffmpeg: ChildProcess | null = null
  private bridge: AudioBridge | null = null
  private timers: NodeJS.Timeout[] = []
  private cancelled = false
  private output = ''
  private warning = ''
  private stderr = ''
  private firstAudio: (() => void) | null = null

  constructor(private hooks: Hooks) {}

  get busy(): boolean {
    return this.state.phase !== 'idle'
  }

  private set(patch: Partial<RecordState>): void {
    this.state = { ...this.state, ...patch }
    this.hooks.onState(this.state)
  }

  private clearTimers(): void {
    this.timers.forEach((t) => clearInterval(t))
    this.timers = []
  }

  async start(source: CaptureSource, opts: RecordOptions): Promise<void> {
    if (this.busy) {
      return
    }
    this.cancelled = false
    this.warning = ''
    this.stderr = ''
    this.set({ phase: 'countdown', countdown: COUNTDOWN_SEC, elapsedSec: 0, audio: opts.audio })

    let left = COUNTDOWN_SEC
    const tick = setInterval(() => {
      left--
      if (left > 0) {
        this.set({ countdown: left })
        return
      }
      clearInterval(tick)
      void this.begin(source, opts).catch((e) =>
        this.finish(e instanceof Error ? e.message : String(e))
      )
    }, 1000)
    this.timers.push(tick)
  }

  private async begin(source: CaptureSource, opts: RecordOptions): Promise<void> {
    if (this.cancelled) {
      return
    }
    const dir = path.join(app.getPath('videos'), 'CineSnack', 'Recordings')
    await fs.mkdir(dir, { recursive: true })
    this.output = path.join(dir, timestampName())

    const support = recordingSupport()
    let withAudio = opts.audio && support.audio !== 'none'
    if (withAudio) {
      this.bridge = new AudioBridge()
      await this.bridge.listen()
      if (support.audio === 'parec') {
        if (!(await this.bridge.startParec())) {
          withAudio = false
          this.warning =
            'Recorded without audio: could not capture system sound (is `parec` installed?).'
        }
      } else {
        const gotAudio = new Promise<boolean>((resolve) => {
          this.firstAudio = () => resolve(true)
          this.timers.push(setTimeout(() => resolve(false), 3000))
        })
        this.hooks.requestRendererAudio(true)
        if (!(await gotAudio)) {
          withAudio = false
          this.hooks.requestRendererAudio(false)
          this.warning = 'Recorded without audio: system sound capture is not available here.'
        }
      }
    }
    const patch = (await this.hooks.beforeCapture?.()) ?? null
    if (this.cancelled) {
      return this.teardown()
    }

    const args = ['-hide_banner', '-y', ...videoInputArgs(source, opts.fps)]
    const finish = 'crop=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p'
    let videoGraph = `[0:v]${finish}[v]`
    let nextInput = 1
    if (patch?.kind === 'window') {
      args.push(
        '-thread_queue_size',
        '1024',
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        'x11grab',
        '-framerate',
        String(opts.fps),
        '-window_id',
        patch.windowId,
        '-i',
        process.env.DISPLAY || ':0'
      )
      nextInput++
      const { x, y, width: w, height: h, srcX, srcY } = patch
      videoGraph =
        `[1:v]crop=${w}:${h}:${srcX}:${srcY}[patch];` +
        `[0:v][patch]overlay=${x}:${y}:eof_action=pass,${finish}[v]`
    } else if (patch?.kind === 'delogo') {
      const { x, y, width: w, height: h } = patch
      videoGraph = `[0:v]delogo=x=${x}:y=${y}:w=${w}:h=${h},${finish}[v]`
    }
    const audioInput = nextInput
    if (withAudio && this.bridge) {
      args.push(
        '-thread_queue_size',
        '1024',
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        's16le',
        '-ar',
        String(RATE),
        '-ac',
        String(CHANNELS),
        '-i',
        `tcp://127.0.0.1:${this.bridge.port}`
      )
    }
    args.push(
      '-filter_complex',
      videoGraph,
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-g',
      String(opts.fps * 2)
    )
    if (withAudio) {
      args.push(
        '-map',
        `${audioInput}:a:0`,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-af',
        'aresample=async=1000'
      )
    }
    // Hard cap: ffmpeg itself stops at 5 minutes even if everything else hangs.
    args.push(
      '-t',
      String(MAX_RECORD_SEC),
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      this.output
    )

    const proc = spawn(getFfmpegPath(), args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    this.ffmpeg = proc
    proc.stderr?.on('data', (c: Buffer) => {
      this.stderr = (this.stderr + c.toString()).slice(-4000)
    })
    proc.on('error', (e) => this.finish(`Could not start ffmpeg: ${e.message}`))
    proc.on('close', (code) => {
      this.ffmpeg = null
      void this.finish(code === 0 ? undefined : this.lastError(code))
    })

    const startedAt = Date.now()
    this.set({ phase: 'recording', countdown: 0, elapsedSec: 0, audio: withAudio })
    const clock = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000
      this.set({ elapsedSec: Math.min(elapsed, MAX_RECORD_SEC) })
      if (elapsed >= MAX_RECORD_SEC + 3) {
        this.stop()
      } // backstop if ffmpeg ignored -t
    }, 250)
    this.timers.push(clock)
  }

  private lastError(code: number | null): string {
    const lines = this.stderr
      .trim()
      .split('\n')
      .filter((l) => !/^\s*(frame=|size=)/.test(l))
    return lines.slice(-3).join('\n') || `ffmpeg exited with code ${code}`
  }

  /** Feed loopback PCM from the renderer (Windows/macOS). */
  pushAudio(chunk: Uint8Array): void {
    this.firstAudio?.()
    this.firstAudio = null
    this.bridge?.write(Buffer.from(chunk))
  }

  stop(): void {
    if (this.state.phase === 'countdown') {
      return this.cancel()
    }
    if (this.state.phase !== 'recording') {
      return
    }
    this.set({ phase: 'finishing' })
    this.hooks.requestRendererAudio(false)
    this.bridge?.end()
    // 'q' asks ffmpeg to finish writing the file cleanly; kill if it doesn't.
    this.ffmpeg?.stdin?.write('q')
    this.ffmpeg?.stdin?.end()
    const proc = this.ffmpeg
    this.timers.push(setTimeout(() => proc?.kill(), 6000))
  }

  cancel(): void {
    this.cancelled = true
    if (this.ffmpeg) {
      this.ffmpeg.kill()
      return
    }
    void this.finish('cancelled')
  }

  private teardown(): void {
    this.clearTimers()
    this.hooks.requestRendererAudio(false)
    this.bridge?.close()
    this.bridge = null
  }

  private async finish(error?: string): Promise<void> {
    if (this.state.phase === 'idle') {
      return
    }
    this.teardown()
    const output = this.output
    this.set({ phase: 'idle', countdown: 0 })

    if (this.cancelled) {
      if (output) {
        await fs.rm(output, { force: true }).catch(() => {})
      }
      return this.hooks.onDone({ ok: false, error: 'cancelled' })
    }
    // Fragmented MP4 is playable even if ffmpeg died mid-way: keep whatever was captured.
    const size = output
      ? await fs
          .stat(output)
          .then((s) => s.size)
          .catch(() => 0)
      : 0
    if (size > 4096) {
      return this.hooks.onDone({
        ok: true,
        outputPath: output,
        warning: error ? `Recording stopped early: ${error}` : this.warning || undefined
      })
    }
    this.hooks.onDone({ ok: false, error: error || 'Nothing was recorded.' })
  }
}
