/**
 * Encode planner shared by the renderer (live estimate) and the main process (actual encode).
 *
 * Given a clip duration and a byte budget, work out the bitrate split between audio and video,
 * then pick the largest resolution that still gets enough bits per pixel to look decent.
 */

export type FpsChoice = 30 | 60
/** 'auto' or the target length of the SHORT side in pixels (e.g. 720 => 1280x720 landscape). */
export type ResolutionChoice = 'auto' | number

export interface PlanInput {
  durationSec: number
  srcWidth: number
  srcHeight: number
  srcFps: number
  hasAudio: boolean
  audioEnabled: boolean
  fps: FpsChoice
  resolution: ResolutionChoice
  maxBytes: number
}

export type Quality = 'great' | 'good' | 'okay' | 'low'

export interface EncodePlan {
  width: number
  height: number
  /** Output frame rate. Null means keep the source frame rate (source is already <= choice). */
  fps: number | null
  effectiveFps: number
  videoKbps: number
  audioKbps: number
  quality: Quality
  /** Bytes we expect the output to be. */
  estimatedBytes: number
  /** False when even the minimum bitrate can't fit this duration in the limit. */
  fits: boolean
}

/** Decimal megabytes: the strictest reading of "50 MB", so uploads never land just over a limit. */
const MB = 1000 * 1000
export const SIZE_PRESETS = [
  { label: '10 MB', bytes: 10 * MB },
  { label: '50 MB', bytes: 50 * MB },
  { label: '500 MB', bytes: 500 * MB }
] as const

export const RESOLUTION_LADDER = [2160, 1440, 1080, 720, 540, 480, 360, 240] as const
/**
 * Auto never goes above 1080p. Bigger frames (and the bitrates they need) stutter in chat-app
 * players and need H.264 level 5.x, which many phones can't decode.
 */
const AUTO_MAX_SHORT = 1080
/** Common frame rates; a source within 1.5% of one is treated as exactly that rate. */
const STANDARD_FPS = [24, 25, 30, 48, 50, 60]

/** Leave headroom for MP4 container overhead and encoder rate-control drift. */
const SAFETY = 0.95
/** Bits-per-pixel-per-frame thresholds for H.264 two-pass. */
const BPP_AUTO_MIN = 0.07
/**
 * Above ~0.1 bpp two-pass H.264 looks no better, the file just gets harder to stream (a 1440p60
 * clip at 0.2 bpp is ~44 Mbps and buffers in most web players). 0.1 is ~12 Mbps at 1080p60.
 */
const BPP_CAP = 0.1

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

export function pickAudioKbps(totalKbps: number): number {
  if (totalKbps >= 1500) {
    return 128
  }
  if (totalKbps >= 600) {
    return 96
  }
  if (totalKbps >= 250) {
    return 64
  }
  return totalKbps >= 120 ? 48 : 32
}

export function scaledSize(
  srcW: number,
  srcH: number,
  shortSide: number
): { width: number; height: number } {
  const srcShort = Math.min(srcW, srcH)
  const target = Math.min(shortSide, srcShort)
  const ratio = target / srcShort
  return { width: even(srcW * ratio), height: even(srcH * ratio) }
}

export function qualityFor(bpp: number): Quality {
  // Slightly under BPP_CAP so a clip at the cap (after rounding) still reads as "great".
  if (bpp >= 0.095) {
    return 'great'
  }
  if (bpp >= 0.065) {
    return 'good'
  }
  if (bpp >= 0.035) {
    return 'okay'
  }
  return 'low'
}

/** Screen recordings report rates like 59.83; snap those to the standard rate they mean. */
export function standardFps(fps: number): number {
  const nearest = STANDARD_FPS.reduce((a, b) => (Math.abs(fps - b) < Math.abs(fps - a) ? b : a))
  return Math.abs(fps - nearest) / nearest <= 0.015 ? nearest : Math.round(fps * 1000) / 1000
}

export function planEncode(input: PlanInput): EncodePlan {
  const duration = Math.max(0.1, input.durationSec)
  const srcFps = standardFps(input.srcFps > 0 ? input.srcFps : 30)
  // Never invent frames: if the source is already at or below the choice, keep its rate.
  const keepSourceFps = srcFps <= input.fps
  const effectiveFps = keepSourceFps ? srcFps : input.fps

  const totalKbps = (input.maxBytes * 8 * SAFETY) / 1000 / duration
  const withAudio = input.hasAudio && input.audioEnabled
  const audioKbps = withAudio ? pickAudioKbps(totalKbps) : 0
  // Tiny floor: absurdly long clips get a mushy result rather than an oversized file.
  let videoKbps = Math.max(16, totalKbps - audioKbps)

  const srcShort = Math.min(input.srcWidth, input.srcHeight)
  const pixelsPerSec = (s: { width: number; height: number }): number =>
    s.width * s.height * effectiveFps

  let size: { width: number; height: number }
  if (input.resolution === 'auto') {
    const top = Math.min(srcShort, AUTO_MAX_SHORT)
    const candidates = [top, ...RESOLUTION_LADDER.filter((r) => r < top)]
    size = scaledSize(input.srcWidth, input.srcHeight, candidates[candidates.length - 1])
    for (const c of candidates) {
      const s = scaledSize(input.srcWidth, input.srcHeight, c)
      if ((videoKbps * 1000) / pixelsPerSec(s) >= BPP_AUTO_MIN) {
        size = s
        break
      }
    }
  } else {
    size = scaledSize(input.srcWidth, input.srcHeight, input.resolution)
  }

  // Short clips don't need to fill the whole budget: cap at a visually lossless-ish rate.
  const capKbps = (pixelsPerSec(size) * BPP_CAP) / 1000
  videoKbps = Math.floor(Math.min(videoKbps, Math.max(capKbps, 500)))

  const bpp = (videoKbps * 1000) / pixelsPerSec(size)
  const estimatedBytes = ((videoKbps + audioKbps) * 1000 * duration) / 8

  return {
    width: size.width,
    height: size.height,
    // Always an explicit constant rate: odd or variable rates confuse some players.
    fps: effectiveFps,
    effectiveFps,
    videoKbps,
    audioKbps,
    quality: qualityFor(bpp),
    estimatedBytes,
    fits: estimatedBytes <= input.maxBytes * SAFETY + 1
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`
  }
  if (bytes >= 1000) {
    return `${Math.round(bytes / 1000)} KB`
  }
  return `${bytes} B`
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`
}
