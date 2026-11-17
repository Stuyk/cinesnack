import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX
} from 'solid-js'
import Copy from 'lucide-solid/icons/copy'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Keyboard from 'lucide-solid/icons/keyboard'
import Pause from 'lucide-solid/icons/pause'
import Play from 'lucide-solid/icons/play'
import SkipBack from 'lucide-solid/icons/skip-back'
import SkipForward from 'lucide-solid/icons/skip-forward'
import StepBack from 'lucide-solid/icons/step-back'
import StepForward from 'lucide-solid/icons/step-forward'
import X from 'lucide-solid/icons/x'
import Segmented from './components/Segmented'
import Timeline from './components/Timeline'
import Toggle from './components/Toggle'
import RecordPicker from './components/RecordPicker'
import Shortcuts from './components/Shortcuts'
import appIcon from '../assets/app-icon.png'
import { startLoopback, stopLoopback } from './loopbackAudio'
import {
  formatBytes,
  formatTime,
  planEncode,
  SIZE_PRESETS,
  type FpsChoice,
  type Quality,
  type ResolutionChoice
} from '../../shared/plan'
import { COMMANDS, matchesAccel, type CommandId } from '../../shared/commands'
import { accelOf, initKeys, isMac, keyOf, tip } from './keys'
import type { ExportResult, ProbeResult, RecordState, WarmupResult } from '../../shared/types'

interface LoadedFile {
  path: string
  name: string
  info: ProbeResult
}

interface Settings {
  fps: FpsChoice
  audio: boolean
  mixAll: boolean
  resolution: ResolutionChoice
  maxBytes: number
  recordAudio: boolean
  autoExport: boolean
}

const DEFAULTS: Settings = {
  fps: 60,
  audio: true,
  mixAll: false,
  resolution: 'auto',
  maxBytes: SIZE_PRESETS[1].bytes,
  recordAudio: true,
  autoExport: false
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('cinesnack-settings')
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const mediaUrl = (p: string): string => `media://local/?p=${encodeURIComponent(p)}`
const key = keyOf
initKeys()

const QUALITY: Record<Quality, { text: string; cls: string }> = {
  great: { text: 'Great', cls: 'text-ok' },
  good: { text: 'Good', cls: 'text-ok' },
  okay: { text: 'Okay', cls: 'text-warn' },
  low: { text: 'Low', cls: 'text-bad' }
}

/** Precise timecode for the transport readouts: m:ss.cc */
function timecode(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(2).padStart(5, '0')}`
}

export default function App(): JSX.Element {
  const [boot, setBoot] = createSignal<WarmupResult | null>(null)
  const [file, setFile] = createSignal<LoadedFile | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal('')
  const [dragOver, setDragOver] = createSignal(false)
  const [showPicker, setShowPicker] = createSignal(false)
  const [showKeys, setShowKeys] = createSignal(false)
  const [notice, setNotice] = createSignal<{ text: string; bad?: boolean } | null>(null)
  const [rec, setRec] = createSignal<RecordState | null>(null)
  /** Shortcut that starts/stops a recording from any app (shown in hints). */
  const globalKey = (): string | null => keyOf('record-focused') || keyOf('record') || null

  const [previewSrc, setPreviewSrc] = createSignal('')
  const [usingProxy, setUsingProxy] = createSignal(false)
  const [proxyProgress, setProxyProgress] = createSignal<number | null>(null)
  const [thumbs, setThumbs] = createSignal<string[]>([])

  const [start, setStart] = createSignal(0)
  const [end, setEnd] = createSignal(0)
  const [current, setCurrent] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)

  const [settings, setSettings] = createSignal<Settings>(loadSettings())
  const update = (patch: Partial<Settings>): void => {
    setSettings((s) => ({ ...s, ...patch }))
  }
  createEffect(() => {
    try {
      localStorage.setItem('cinesnack-settings', JSON.stringify(settings()))
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  })

  const [exporting, setExporting] = createSignal(false)
  const [progress, setProgress] = createSignal({ p: 0, label: '' })
  const [result, setResult] = createSignal<ExportResult | null>(null)
  const [status, setStatus] = createSignal('')

  let video: HTMLVideoElement | undefined

  const hasAudio = (): boolean => (file()?.info.audioTracks ?? 1) > 0
  const sizeIndex = (): number => SIZE_PRESETS.findIndex((p) => p.bytes === settings().maxBytes)
  const dialogOpen = (): boolean => showPicker() || showKeys()

  // Window title and native menu follow the app state.
  createEffect(() => {
    document.title = file() ? `${file()!.name} - CineSnack` : 'CineSnack'
  })
  createEffect(() => {
    window.api.sendUiState({
      hasFile: !!file(),
      exporting: exporting(),
      hasOutput: !!result()?.ok,
      fps: settings().fps,
      audio: settings().audio,
      audioAvailable: hasAudio(),
      sizeIndex: sizeIndex(),
      recordAudio: settings().recordAudio,
      autoExport: settings().autoExport
    })
  })

  // ---------- loading ----------
  async function openPath(path: string): Promise<void> {
    if (exporting()) {
      return
    }
    setLoading(true)
    setLoadError('')
    setResult(null)
    try {
      const info = await window.api.probe(path)
      const name = path.split(/[\\/]/).pop() ?? path
      setFile({ path, name, info })
      setStart(0)
      setEnd(info.durationSec)
      setCurrent(0)
      setPlaying(false)
      setUsingProxy(false)
      setProxyProgress(null)
      setThumbs([])
      setPreviewSrc(mediaUrl(path))
      setStatus(`Opened ${name}`)
      window.api.thumbnails(path, info.durationSec).then((t) => {
        if (file()?.path === path) {
          setThumbs(t)
        }
      })
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message.replace(/^Error invoking.*?Error: /, '') : String(err)
      )
    } finally {
      setLoading(false)
    }
  }

  async function pick(): Promise<void> {
    const p = await window.api.pickFile()
    if (p) {
      void openPath(p)
    }
  }

  function closeVideo(): void {
    video?.pause()
    setFile(null)
    setPreviewSrc('')
    setThumbs([])
    setResult(null)
    setStatus('')
  }

  async function fallbackToProxy(): Promise<void> {
    const f = file()
    if (!f || usingProxy()) {
      return
    }
    setUsingProxy(true)
    setProxyProgress(0)
    const proxy = await window.api.previewProxy(f.path, f.info.durationSec)
    if (file()?.path !== f.path) {
      return
    }
    setProxyProgress(null)
    if (proxy) {
      setPreviewSrc(mediaUrl(proxy))
      if (video) {
        video.currentTime = current()
      }
    }
  }

  // ---------- playback ----------
  function seek(t: number): void {
    const d = file()?.info.durationSec ?? 0
    const c = Math.max(0, Math.min(d, t))
    setCurrent(c)
    if (video && Number.isFinite(c)) {
      video.currentTime = c
    }
  }

  function togglePlay(): void {
    if (!video) {
      return
    }
    if (video.paused) {
      if (current() < start() || current() >= end() - 0.05) {
        seek(start())
      }
      void video.play()
    } else {
      video.pause()
    }
  }

  let raf = 0
  const tick = (): void => {
    if (video && !video.paused) {
      const t = video.currentTime
      if (t >= end()) {
        video.currentTime = start()
        setCurrent(start())
      } else {
        setCurrent(t)
      }
      raf = requestAnimationFrame(tick)
    }
  }

  const frame = (): number => 1 / (file()?.info.fps || 30)
  const markIn = (): void => {
    setStart(Math.min(current(), end() - 0.2))
  }
  const markOut = (): void => {
    setEnd(Math.max(current(), start() + 0.2))
  }
  const clearTrim = (): void => {
    setStart(0)
    setEnd(file()?.info.durationSec ?? 0)
  }

  // ---------- export ----------
  const plan = createMemo(() => {
    const f = file()
    if (!f) {
      return null
    }
    const s = settings()
    return planEncode({
      durationSec: end() - start(),
      srcWidth: f.info.width,
      srcHeight: f.info.height,
      srcFps: f.info.fps,
      hasAudio: f.info.audioTracks > 0,
      audioEnabled: s.audio,
      fps: s.fps,
      resolution: s.resolution,
      maxBytes: s.maxBytes
    })
  })

  const resolutionOptions = createMemo(() => {
    const f = file()
    const short = f ? Math.min(f.info.width, f.info.height) : 1080
    const fixed = [1080, 720, 480].filter((r) => r <= short)
    if (!fixed.length) {
      fixed.push(short)
    }
    return [
      {
        value: 'auto' as ResolutionChoice,
        label: 'Auto',
        title: 'Picks the sharpest size that still fits'
      },
      ...fixed.map((r) => ({ value: r as ResolutionChoice, label: `${r}p` }))
    ]
  })

  async function doExport(auto = false): Promise<void> {
    const f = file()
    if (!f || exporting() || !plan()?.fits) {
      return
    }
    video?.pause()
    const s = settings()
    setExporting(true)
    setResult(null)
    setProgress({ p: 0, label: 'Starting' })
    const res = await window.api.startExport({
      input: f.path,
      startSec: start(),
      endSec: end(),
      fps: s.fps,
      audio: s.audio,
      mixAllAudio: s.mixAll,
      resolution: s.resolution,
      maxBytes: s.maxBytes,
      fast: auto,
      auto
    })
    setExporting(false)
    if (res.error === 'cancelled') {
      setStatus('Export cancelled')
      return
    }
    setResult(res)
    setStatus(
      res.ok
        ? res.copied
          ? `Exported ${formatBytes(res.bytes ?? 0)} and copied to the clipboard`
          : `Exported ${formatBytes(res.bytes ?? 0)}`
        : 'Export failed'
    )
  }

  async function copyOutput(): Promise<void> {
    const out = result()?.outputPath
    if (!out) {
      return
    }
    const ok = await window.api.copyToClipboard(out)
    setStatus(ok ? 'Copied to the clipboard' : "Couldn't copy the file. Drag it instead.")
  }

  // ---------- commands (menu, keyboard, buttons) ----------
  function run(id: CommandId): void {
    const f = file()
    const busy = exporting() || (rec()?.phase ?? 'idle') !== 'idle'
    switch (id) {
      case 'open':
        return void (!busy && pick())
      case 'record':
        return void (!busy && setShowPicker(true))
      case 'shortcuts':
        return void setShowKeys(true)
      case 'cancel':
        return void (exporting() && window.api.cancelExport())
      case 'copy-output':
        return void copyOutput()
      case 'reveal-output':
        return void (result()?.outputPath && window.api.reveal(result()!.outputPath!))
      case 'fps-30':
      case 'fps-60':
        return void (!exporting() && update({ fps: id === 'fps-30' ? 30 : 60 }))
      case 'toggle-auto-export':
        return void update({ autoExport: !settings().autoExport })
      case 'toggle-audio':
        return void (!exporting() && hasAudio() && update({ audio: !settings().audio }))
      case 'size-0':
      case 'size-1':
      case 'size-2':
        return void (!exporting() && update({ maxBytes: SIZE_PRESETS[Number(id.slice(-1))].bytes }))
    }
    if (!f || exporting()) {
      return
    }
    switch (id) {
      case 'export':
        return void doExport()
      case 'close-video':
        return closeVideo()
      case 'play':
        return togglePlay()
      case 'step-back':
        return seek(current() - frame())
      case 'step-forward':
        return seek(current() + frame())
      case 'jump-back':
        return seek(current() - 1)
      case 'jump-forward':
        return seek(current() + 1)
      case 'go-start':
        return seek(0)
      case 'go-end':
        return seek(f.info.durationSec)
      case 'mark-in':
        return markIn()
      case 'mark-out':
        return markOut()
      case 'go-in':
        return seek(start())
      case 'go-out':
        return seek(end())
      case 'clear-trim':
        return clearTrim()
    }
  }

  // ---------- global listeners ----------
  onMount(() => {
    window.api
      .warmup()
      .then(setBoot)
      .catch((e) => setBoot({ ok: false, error: String(e) }))
    const offRec = window.api.onRecordDone((r) => {
      setRec(null)
      if (r.ok && r.outputPath) {
        setNotice(r.warning ? { text: r.warning } : null)
        void openPath(r.outputPath).then(() => {
          if (!settings().autoExport || file()?.path !== r.outputPath) {
            return
          }
          if (plan()?.fits) {
            void doExport(true)
          } else {
            setNotice({
              text: `Auto-export skipped: this recording is too long for ${formatBytes(settings().maxBytes)}. Trim it or pick a bigger limit, then export.`
            })
            window.api.showWindow()
          }
        })
      } else if (r.error && r.error !== 'cancelled') {
        setNotice({ text: `Recording failed: ${r.error}`, bad: true })
      }
    })
    const offState = window.api.onRecordState((s) => setRec(s.phase === 'idle' ? null : s))
    const offAudio = window.api.onAudioCapture((on) => (on ? void startLoopback() : stopLoopback()))
    const offCmd = window.api.onCommand((c) => {
      if (!dialogOpen() || c === 'shortcuts') {
        run(c)
      }
    })
    const offOpen = window.api.onOpenPath((p) => void openPath(p))
    const offProgress = window.api.onProgress((e) => {
      if (e.kind === 'export') {
        setProgress({ p: e.progress, label: e.label })
      } else {
        setProxyProgress(e.progress)
      }
    })

    const local = COMMANDS.filter((c) => c.scope === 'local')
    const onKey = (e: KeyboardEvent): void => {
      if (boot()?.ok === false || dialogOpen() || e.defaultPrevented) {
        return
      }
      const t = e.target as HTMLElement
      // Let focused controls keep their own keys (Space on a button, arrows in a radio group).
      const ownsKey =
        t instanceof HTMLInputElement ||
        (t.closest('button, [role="slider"], [role="radio"]') &&
          [
            'Space',
            'Enter',
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Home',
            'End'
          ].includes(e.code))
      if (ownsKey) {
        return
      }
      const hit = local.find((c) => matchesAccel(e, accelOf(c.id), isMac))
      if (hit) {
        e.preventDefault()
        run(hit.id)
      }
    }
    let depth = 0
    const onDragEnter = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) {
        return
      }
      depth++
      setDragOver(true)
    }
    const onDragLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (!depth) {
        setDragOver(false)
      }
    }
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setDragOver(false)
      const f = e.dataTransfer?.files[0]
      if (f) {
        void openPath(window.api.pathForFile(f))
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    onCleanup(() => {
      offRec()
      offState()
      offAudio()
      offCmd()
      offOpen()
      offProgress()
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    })
  })

  // ---------- view ----------
  const length = (): number => end() - start()
  const statusText = (): string => {
    if (exporting()) {
      return `${progress().label} · ${Math.round(progress().p * 100)}%`
    }
    if (loading()) {
      return 'Reading video…'
    }
    return status() || 'Ready'
  }

  return (
    <div class="h-full flex flex-col select-none">
      {/* Toolbar */}
      <header class="h-11 shrink-0 flex items-center gap-1.5 px-2 bg-panel border-b border-line">
        <div class="flex items-center gap-2 pl-1 pr-3 mr-1 border-r border-line h-6">
          <img src={appIcon} class="w-5 h-5" alt="" />
          <span class="text-[13px] font-semibold tracking-[0.01em]">CineSnack</span>
        </div>
        <button
          class="btn"
          onClick={() => run('open')}
          disabled={exporting()}
          title={tip('Open a video', 'open')}
        >
          <FolderOpen size={14} /> Open
        </button>
        <button
          class="btn"
          onClick={() => run('record')}
          disabled={exporting() || !!rec()}
          title={tip('Record a screen or window', 'record')}
        >
          <span class="w-2.5 h-2.5 rounded-full bg-rec" aria-hidden="true" /> Record
        </button>
        <div class="flex-1" />
        <button
          class="btn btn-ghost btn-icon"
          onClick={() => run('shortcuts')}
          title={tip('Keyboard shortcuts', 'shortcuts')}
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={16} />
        </button>
        <Show
          when={!exporting()}
          fallback={
            <button
              class="btn"
              onClick={() => run('cancel')}
              title={tip('Cancel export', 'cancel')}
            >
              Cancel export
            </button>
          }
        >
          <button
            class="btn btn-primary"
            onClick={() => run('export')}
            disabled={!plan()?.fits}
            title={tip('Export and copy to clipboard', 'export')}
          >
            Export & Copy <span class="opacity-75 font-normal text-[12px]">{key('export')}</span>
          </button>
        </Show>
      </header>

      <Show when={rec()}>
        {(r) => (
          <div
            class="shrink-0 flex items-center gap-3 px-3 h-9 bg-[#2a1418] border-b border-[#5c2a31]"
            role="status"
          >
            <span class="w-2.5 h-2.5 rounded-full bg-rec animate-pulse" aria-hidden="true" />
            <span class="font-semibold">
              {r().phase === 'countdown'
                ? `Recording starts in ${r().countdown}`
                : r().phase === 'finishing'
                  ? 'Saving recording…'
                  : 'Recording'}
            </span>
            <Show when={r().phase === 'recording'}>
              <span class="mono text-fg-2">
                {formatTime(r().elapsedSec)} / {formatTime(r().maxSec)}
              </span>
            </Show>
            <div class="flex-1" />
            <Show when={globalKey()}>
              <span class="text-fg-2 text-[12px]">
                Stop from any app with <kbd>{globalKey()}</kbd>
              </span>
            </Show>
            <Show when={r().phase !== 'finishing'}>
              <button
                class="btn"
                onClick={() =>
                  r().phase === 'countdown'
                    ? window.api.cancelRecording()
                    : window.api.stopRecording()
                }
              >
                {r().phase === 'countdown' ? 'Cancel' : 'Stop'}
              </button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={notice()}>
        {(n) => (
          <div
            role="alert"
            class="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b text-[13px]"
            classList={{
              'bg-[#2a1418] border-[#5c2a31]': n().bad,
              'bg-[#2a2210] border-[#5a4719]': !n().bad
            }}
          >
            <span class="font-semibold" classList={{ 'text-bad': n().bad, 'text-warn': !n().bad }}>
              {n().bad ? 'Error' : 'Note'}
            </span>
            <span class="flex-1 whitespace-pre-wrap text-fg-2">{n().text}</span>
            <button
              class="btn btn-ghost btn-icon h-6!"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </Show>

      <div class="flex-1 min-h-0 flex gap-1.5 p-1.5">
        <div class="flex-1 min-w-0 flex flex-col gap-1.5">
          {/* Viewer */}
          <section
            class="panel flex-1 min-h-[160px] flex flex-col overflow-hidden"
            aria-label="Viewer"
          >
            <div class="panel-head">
              <span>Viewer</span>
              <Show when={file()}>
                {(f) => (
                  <span class="ml-auto min-w-0 truncate font-normal text-fg-3" title={f().path}>
                    <span class="text-fg-2">{f().name}</span>
                    <span class="mono text-[11px]">
                      {'  '}
                      {f().info.width}×{f().info.height} · {Math.round(f().info.fps)} fps ·{' '}
                      {formatTime(f().info.durationSec)}
                      {f().info.audioTracks > 1 ? ` · ${f().info.audioTracks} audio tracks` : ''}
                      {f().info.audioTracks === 0 ? ' · no audio' : ''}
                    </span>
                  </span>
                )}
              </Show>
            </div>
            <div class="relative flex-1 min-h-0 bg-base flex items-center justify-center">
              <Show
                when={file()}
                fallback={
                  <EmptyState
                    onPick={() => run('open')}
                    onRecord={() => run('record')}
                    loading={loading()}
                    error={loadError()}
                    dragOver={dragOver()}
                  />
                }
              >
                <video
                  ref={video}
                  src={previewSrc()}
                  class="w-full h-full object-contain"
                  preload="auto"
                  onClick={togglePlay}
                  onPlay={() => {
                    setPlaying(true)
                    raf = requestAnimationFrame(tick)
                  }}
                  onPause={() => setPlaying(false)}
                  onError={() => void fallbackToProxy()}
                  onLoadedMetadata={(e) => {
                    if (e.currentTarget.videoWidth === 0) {
                      void fallbackToProxy()
                    }
                  }}
                />
                <Show when={proxyProgress() !== null}>
                  <div
                    class="absolute inset-0 bg-base/90 flex flex-col items-center justify-center gap-2"
                    role="status"
                  >
                    <span class="mono text-[13px]">
                      Building preview {Math.round((proxyProgress() ?? 0) * 100)}%
                    </span>
                    <span class="text-[12px] text-fg-2">
                      This format can't play directly. Trimming and export already work.
                    </span>
                  </div>
                </Show>
                <Show when={dragOver()}>
                  <div class="absolute inset-3 rounded-md border-2 border-dashed border-accent bg-accent-soft/70 flex items-center justify-center pointer-events-none">
                    <span class="text-[15px] font-semibold">Drop to open this video</span>
                  </div>
                </Show>
              </Show>
            </div>
          </section>

          {/* Timeline */}
          <section class="panel shrink-0 flex flex-col" aria-label="Timeline">
            <div class="panel-head gap-1!">
              <span class="mr-2">Timeline</span>
              <TransportButton
                label={tip('Go to start', 'go-start')}
                onClick={() => run('go-start')}
                disabled={!file()}
              >
                <SkipBack size={14} />
              </TransportButton>
              <TransportButton
                label={tip('Previous frame', 'step-back')}
                onClick={() => run('step-back')}
                disabled={!file()}
              >
                <StepBack size={14} />
              </TransportButton>
              <TransportButton
                label={tip(playing() ? 'Pause' : 'Play', 'play')}
                onClick={() => run('play')}
                disabled={!file()}
              >
                <Show when={playing()} fallback={<Play size={14} fill="currentColor" />}>
                  <Pause size={14} fill="currentColor" />
                </Show>
              </TransportButton>
              <TransportButton
                label={tip('Next frame', 'step-forward')}
                onClick={() => run('step-forward')}
                disabled={!file()}
              >
                <StepForward size={14} />
              </TransportButton>
              <TransportButton
                label={tip('Go to end', 'go-end')}
                onClick={() => run('go-end')}
                disabled={!file()}
              >
                <SkipForward size={14} />
              </TransportButton>
              <span class="mono text-[14px] text-fg ml-2 font-medium" aria-label="Current time">
                {timecode(current())}
              </span>
              <div class="flex-1" />
              <Readout label="In" value={timecode(start())} />
              <Readout label="Out" value={timecode(end())} />
              <Readout label="Length" value={timecode(length())} strong />
            </div>
            <div class="pt-2 pb-2.5">
              <Show
                when={file()}
                fallback={
                  <div class="mx-3 h-[84px] rounded-[4px] border border-dashed border-line-strong flex items-center justify-center text-fg-3 text-[12px]">
                    No clip loaded
                  </div>
                }
              >
                {(f) => (
                  <Timeline
                    duration={f().info.durationSec}
                    fps={f().info.fps}
                    start={start()}
                    end={end()}
                    current={current()}
                    thumbs={thumbs()}
                    disabled={exporting()}
                    onTrim={(s, e) => {
                      setStart(s)
                      setEnd(e)
                    }}
                    onSeek={seek}
                    onDragStart={() => video?.pause()}
                  />
                )}
              </Show>
              <div class="flex items-center gap-1.5 px-3 pt-2.5">
                <button
                  class="btn"
                  onClick={() => run('mark-in')}
                  disabled={!file() || exporting()}
                  title={tip('Set in point at playhead', 'mark-in')}
                >
                  Set In <kbd>{key('mark-in')}</kbd>
                </button>
                <button
                  class="btn"
                  onClick={() => run('mark-out')}
                  disabled={!file() || exporting()}
                  title={tip('Set out point at playhead', 'mark-out')}
                >
                  Set Out <kbd>{key('mark-out')}</kbd>
                </button>
                <button
                  class="btn"
                  onClick={() => run('clear-trim')}
                  disabled={
                    !file() ||
                    exporting() ||
                    (start() === 0 && end() === (file()?.info.durationSec ?? 0))
                  }
                  title={tip('Clear in and out points', 'clear-trim')}
                >
                  Clear <kbd>{key('clear-trim')}</kbd>
                </button>
                <span class="ml-auto text-[12px] text-fg-3">
                  Drag the blue handles, or focus one and use <kbd>←</kbd> <kbd>→</kbd>
                </span>
              </div>
            </div>
          </section>
        </div>

        {/* Attributes */}
        <aside
          class="panel w-[300px] shrink-0 flex flex-col overflow-hidden"
          aria-label="Export settings"
        >
          <div class="panel-head">Export Settings</div>
          <div class="flex-1 min-h-0 overflow-y-auto">
            <Group title="Target">
              <div class="field">
                <span class="label" id="lbl-size">
                  Size limit
                </span>
                <Segmented
                  label="Size limit"
                  disabled={exporting()}
                  value={settings().maxBytes}
                  onChange={(v) => update({ maxBytes: v })}
                  options={SIZE_PRESETS.map((p, i) => ({
                    value: p.bytes as number,
                    label: p.label,
                    title: `${p.label} limit (${keyOf(`size-${i}` as CommandId) || 'no shortcut'})`
                  }))}
                />
              </div>
            </Group>

            <Group title="Video">
              <div class="field">
                <span class="label">Frame rate</span>
                <Segmented
                  label="Frame rate"
                  disabled={exporting()}
                  value={settings().fps}
                  onChange={(v) => update({ fps: v })}
                  options={[
                    { value: 30 as FpsChoice, label: '30 fps' },
                    { value: 60 as FpsChoice, label: '60 fps' }
                  ]}
                />
              </div>
              <Show when={file() && file()!.info.fps < settings().fps - 0.5}>
                <Hint>Source is {Math.round(file()!.info.fps)} fps, so it stays at that.</Hint>
              </Show>
              <div class="field">
                <span class="label">Resolution</span>
                <Segmented
                  label="Resolution"
                  disabled={exporting()}
                  value={settings().resolution}
                  onChange={(v) => update({ resolution: v })}
                  options={resolutionOptions()}
                />
              </div>
            </Group>

            <Group title="Audio">
              <div class="field">
                <span class="label">Include</span>
                <div>
                  <Toggle
                    label="Include audio"
                    checked={hasAudio() && settings().audio}
                    disabled={exporting() || !hasAudio()}
                    onChange={(v) => update({ audio: v })}
                  >
                    <span class="text-fg-2">
                      {hasAudio() ? (settings().audio ? 'On' : 'Muted') : 'No audio track'}
                    </span>
                  </Toggle>
                </div>
              </div>
              <Show when={(file()?.info.audioTracks ?? 0) > 1 && settings().audio}>
                <div class="field">
                  <span class="label">Tracks</span>
                  <Toggle
                    label="Mix all audio tracks"
                    checked={settings().mixAll}
                    disabled={exporting()}
                    onChange={(v) => update({ mixAll: v })}
                  >
                    <span class="text-fg-2">Mix all {file()!.info.audioTracks}</span>
                  </Toggle>
                </div>
              </Show>
            </Group>

            <Group title="Recordings">
              <div class="field">
                <span class="label">Auto-export</span>
                <Toggle
                  label="Auto-export recordings"
                  checked={settings().autoExport}
                  onChange={(v) => update({ autoExport: v })}
                >
                  <span class="text-fg-2">{settings().autoExport ? 'On' : 'Off'}</span>
                </Toggle>
              </div>
              <Hint>
                When a recording stops, export it with these settings and copy it straight away,
                using a faster encode. The window stays hidden; you get a notification.
              </Hint>
            </Group>

            <Group title="Estimate" last>
              <Show
                when={plan()}
                fallback={
                  <p class="text-[12px] text-fg-2">
                    Open a video to see the output size and quality.
                  </p>
                }
              >
                {(p) => (
                  <>
                    <div class="flex items-baseline justify-between">
                      <span class="mono text-[18px] font-medium">
                        ≈ {formatBytes(p().estimatedBytes)}
                      </span>
                      <span class="text-[12px] text-fg-2">
                        of {formatBytes(settings().maxBytes)}
                      </span>
                    </div>
                    <div
                      class="h-1.5 rounded-full bg-app overflow-hidden"
                      role="meter"
                      aria-label="Estimated size compared to the limit"
                      aria-valuemin={0}
                      aria-valuemax={settings().maxBytes}
                      aria-valuenow={p().estimatedBytes}
                    >
                      <div
                        class="h-full rounded-full"
                        classList={{ 'bg-accent': p().fits, 'bg-bad': !p().fits }}
                        style={{
                          width: `${Math.min(100, (p().estimatedBytes / settings().maxBytes) * 100)}%`
                        }}
                      />
                    </div>
                    <dl class="grid grid-cols-[84px_1fr] gap-x-2.5 gap-y-1 text-[12px] mt-1">
                      <dt class="text-fg-2 text-right">Quality</dt>
                      <dd class={`font-semibold ${QUALITY[p().quality].cls}`}>
                        {QUALITY[p().quality].text}
                      </dd>
                      <dt class="text-fg-2 text-right">Size</dt>
                      <dd class="mono">
                        {p().width}×{p().height}
                      </dd>
                      <dt class="text-fg-2 text-right">Frame rate</dt>
                      <dd class="mono">{Math.round(p().effectiveFps)} fps</dd>
                      <dt class="text-fg-2 text-right">Video</dt>
                      <dd class="mono">{(p().videoKbps / 1000).toFixed(1)} Mbps</dd>
                      <dt class="text-fg-2 text-right">Audio</dt>
                      <dd class="mono">{p().audioKbps ? `${p().audioKbps} kbps` : 'none'}</dd>
                    </dl>
                    <Show when={!p().fits}>
                      <p class="text-[12px] text-bad" role="alert">
                        Too long for {formatBytes(settings().maxBytes)}. Trim it or pick a bigger
                        limit.
                      </p>
                    </Show>
                    <Show when={p().fits && p().quality === 'low'}>
                      <p class="text-[12px] text-warn">
                        A lot of video for this size. A shorter clip, 30 fps or a bigger limit will
                        look sharper.
                      </p>
                    </Show>
                  </>
                )}
              </Show>
            </Group>
          </div>

          <div
            class="shrink-0 border-t border-line p-2.5 flex flex-col gap-2 bg-raised/50"
            aria-live="polite"
          >
            <Switch>
              <Match when={exporting()}>
                <div>
                  <div class="flex justify-between mb-1.5 text-[12px]">
                    <span>{progress().label}</span>
                    <span class="mono">{Math.round(progress().p * 100)}%</span>
                  </div>
                  <div
                    class="h-1.5 rounded-full bg-app overflow-hidden"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress().p * 100)}
                  >
                    <div
                      class="h-full bg-accent transition-[width] duration-200"
                      style={{ width: `${progress().p * 100}%` }}
                    />
                  </div>
                </div>
                <button class="btn" onClick={() => run('cancel')}>
                  Cancel <kbd>{key('cancel')}</kbd>
                </button>
              </Match>
              <Match when={true}>
                <Show when={result()}>
                  {(r) => (
                    <Show
                      when={r().ok}
                      fallback={
                        <div
                          class="rounded-[5px] border border-[#5c2a31] bg-[#2a1418] p-2 text-[12px] mono whitespace-pre-wrap max-h-28 overflow-y-auto select-text"
                          role="alert"
                        >
                          Export failed: {r().error}
                        </div>
                      }
                    >
                      <DoneCard
                        result={r()}
                        onCopy={() => run('copy-output')}
                        onReveal={() => run('reveal-output')}
                        onDrag={() => window.api.startDrag(r().outputPath!)}
                      />
                    </Show>
                  )}
                </Show>
                <button
                  class="btn btn-primary btn-lg"
                  onClick={() => run('export')}
                  disabled={!plan()?.fits}
                >
                  {result()?.ok ? 'Export Again' : 'Export & Copy to Clipboard'}
                </button>
              </Match>
            </Switch>
          </div>
        </aside>
      </div>

      {/* Status bar */}
      <footer class="h-6 shrink-0 flex items-center gap-3 px-3 text-[12px] text-fg-2 bg-panel border-t border-line">
        <span class="flex items-center gap-1.5" role="status">
          <span
            class="w-1.5 h-1.5 rounded-full"
            classList={{ 'bg-accent animate-pulse': exporting(), 'bg-ok': !exporting() }}
            aria-hidden="true"
          />
          {statusText()}
        </span>
        <div class="flex-1" />
        <Show when={globalKey()}>
          <span>
            Record focused window <kbd>{globalKey()}</kbd>
          </span>
        </Show>
        <span>
          Shortcuts <kbd>{key('shortcuts')}</kbd>
        </span>
      </footer>

      <Show when={showPicker()}>
        <RecordPicker
          audio={settings().recordAudio}
          fps={settings().fps}
          stopKey={globalKey()}
          onAudio={(v) => update({ recordAudio: v })}
          onClose={() => setShowPicker(false)}
          onPicked={() => {
            setShowPicker(false)
            setNotice(null)
          }}
        />
      </Show>
      {/* The editor is usable immediately; this only appears if ffmpeg can't run. */}
      <Show when={boot()?.ok === false}>
        <BootScreen result={boot()} />
      </Show>

      <Show when={showKeys()}>
        <Shortcuts onClose={() => setShowKeys(false)} />
      </Show>
    </div>
  )
}

/** Covers the window while ffmpeg starts. Matches the static splash in index.html. */
function BootScreen(props: { result: WarmupResult | null }): JSX.Element {
  return (
    <div
      class="fixed inset-0 z-50 bg-app flex flex-col items-center justify-center gap-3.5"
      role="status"
      aria-live="polite"
    >
      <img src={appIcon} alt="" class="w-14 h-14" />
      <div class="text-[18px] font-semibold tracking-[0.01em]">CineSnack</div>
      <Show
        when={props.result?.error}
        fallback={
          <>
            <div class="w-[180px] h-[3px] rounded bg-raised overflow-hidden">
              <div class="boot-slide h-full w-2/5 rounded bg-accent" />
            </div>
            <div class="text-fg-2">Starting the video engine…</div>
          </>
        }
      >
        <div class="max-w-[460px] text-center text-bad select-text" role="alert">
          {props.result?.error}
        </div>
        <button class="btn" onClick={() => location.reload()}>
          Try Again
        </button>
      </Show>
    </div>
  )
}

function EmptyState(props: {
  onPick: () => void
  onRecord: () => void
  loading: boolean
  error: string
  dragOver: boolean
}): JSX.Element {
  return (
    <div
      class="w-[420px] max-w-[90%] rounded-lg border border-dashed p-6 text-center transition-colors"
      classList={{
        'border-accent bg-accent-soft/60': props.dragOver,
        'border-line-strong': !props.dragOver
      }}
    >
      <img src={appIcon} alt="" class="w-11 h-11 mx-auto" />
      <h1 class="mt-3 text-[16px] font-semibold">
        {props.loading
          ? 'Reading video…'
          : props.dragOver
            ? 'Drop to open'
            : 'Open a video to start'}
      </h1>
      <p class="mt-1 text-fg-2 text-[13px]">
        Drop a file here, or open or record one. Any format ffmpeg reads works.
      </p>
      <div class="mt-4 flex justify-center gap-2">
        <button class="btn btn-primary" onClick={props.onPick} disabled={props.loading}>
          <FolderOpen size={14} /> Open Video…{' '}
          <span class="opacity-75 font-normal text-[12px]">{key('open')}</span>
        </button>
        <button class="btn" onClick={props.onRecord} disabled={props.loading}>
          <span class="w-2.5 h-2.5 rounded-full bg-rec" aria-hidden="true" /> Record…{' '}
          <span class="text-fg-3 text-[12px]">{key('record')}</span>
        </button>
      </div>
      <p class="mt-4 text-[12px] text-fg-3">
        Recordings start after a 5 second countdown, include computer audio, and stop at 5:00.
      </p>
      <Show when={props.error}>
        <div
          class="mt-3 rounded-[5px] border border-[#5c2a31] bg-[#2a1418] p-2 text-left mono text-[12px] whitespace-pre-wrap select-text"
          role="alert"
        >
          {props.error}
        </div>
      </Show>
    </div>
  )
}

function DoneCard(props: {
  result: ExportResult
  onCopy: () => void
  onReveal: () => void
  onDrag: () => void
}): JSX.Element {
  const paste = isMac ? '⌘V' : 'Ctrl+V'
  return (
    <div
      class="rounded-[5px] border p-2 flex flex-col gap-1.5"
      classList={{
        'border-[#245c45] bg-[#10261e]': props.result.copied,
        'border-[#5a4719] bg-[#2a2210]': !props.result.copied
      }}
    >
      <div class="text-[13px] font-semibold">
        <Show
          when={props.result.copied}
          fallback="Saved. Couldn't copy it to the clipboard, so drag it where you need it."
        >
          Copied. Paste it anywhere with <kbd>{paste}</kbd>
        </Show>
      </div>
      <div class="mono text-[11px] text-fg-2 truncate" title={props.result.outputPath}>
        {formatBytes(props.result.bytes ?? 0)} · {props.result.outputPath?.split(/[\\/]/).pop()}
      </div>
      <div class="flex gap-1.5">
        <div
          draggable={true}
          onDragStart={(e) => {
            e.preventDefault()
            props.onDrag()
          }}
          title="Drag the file into a chat, email or folder"
          class="btn flex-1 cursor-grab"
          role="button"
          tabIndex={-1}
        >
          Drag
        </div>
        <button
          class="btn flex-1"
          onClick={props.onCopy}
          title={tip('Copy file again', 'copy-output')}
        >
          <Copy size={13} /> Copy
        </button>
        <button
          class="btn flex-1"
          onClick={props.onReveal}
          title={tip('Show in folder', 'reveal-output')}
        >
          <FolderOpen size={13} /> Folder
        </button>
      </div>
    </div>
  )
}

function Group(props: { title: string; last?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <section
      class="px-3 py-2.5 flex flex-col gap-2"
      classList={{ 'border-b border-line': !props.last }}
    >
      <h3 class="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">{props.title}</h3>
      {props.children}
    </section>
  )
}

function Hint(props: { children: JSX.Element }): JSX.Element {
  return <p class="text-[12px] text-fg-2 pl-[94px]">{props.children}</p>
}

function TransportButton(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      class="btn btn-ghost btn-icon h-6! w-6! text-fg-2 hover:text-fg"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.label}
      aria-label={props.label}
    >
      {props.children}
    </button>
  )
}

function Readout(props: { label: string; value: string; strong?: boolean }): JSX.Element {
  return (
    <span class="flex items-baseline gap-1.5 ml-3 font-normal">
      <span class="text-fg-3 text-[11px]">{props.label}</span>
      <span
        class="mono text-[12px]"
        classList={{ 'text-accent-fg font-medium': props.strong, 'text-fg-2': !props.strong }}
      >
        {props.value}
      </span>
    </span>
  )
}
