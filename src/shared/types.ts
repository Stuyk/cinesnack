import type { FpsChoice, ResolutionChoice } from './plan'

export interface ProbeResult {
  durationSec: number
  width: number
  height: number
  fps: number
  audioTracks: number
  codec: string
}

export interface WarmupResult {
  ok: boolean
  version?: string
  error?: string
}

export interface ExportRequest {
  input: string
  startSec: number
  endSec: number
  fps: FpsChoice
  audio: boolean
  mixAllAudio: boolean
  resolution: ResolutionChoice
  maxBytes: number
  /** Faster x264 preset: used for auto-export, where speed matters more than the last bit of detail. */
  fast?: boolean
  /** Started automatically after a recording; the main process notifies instead of popping up. */
  auto?: boolean
}

export interface ExportResult {
  ok: boolean
  outputPath?: string
  bytes?: number
  copied?: boolean
  error?: string
}

export interface ProgressEvent {
  kind: 'export' | 'preview'
  /** 0..1 */
  progress: number
  label: string
}

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** data: URL, may be empty */
  thumbnail: string
  displayId?: string
}

export interface RecordOptions {
  audio: boolean
  fps: number
}

export interface RecordState {
  phase: 'idle' | 'countdown' | 'recording' | 'finishing'
  countdown: number
  elapsedSec: number
  maxSec: number
  audio: boolean
}

export interface RecordResult {
  ok: boolean
  outputPath?: string
  warning?: string
  error?: string
}

export interface SourcesResult {
  ok: boolean
  reason?: string
  sources: CaptureSource[]
}
