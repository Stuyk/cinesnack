import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { planEncode, type EncodePlan } from '../shared/plan'
import type { ExportRequest, ProbeResult } from '../shared/types'
import { runFfmpeg } from './ffmpeg'

const MAX_ATTEMPTS = 3
const PASS1_WEIGHT = 0.35

export interface EncodeCallbacks {
  onProgress: (progress: number, label: string) => void
  signal: AbortSignal
}

export async function outputPathFor(input: string): Promise<string> {
  const dir = path.join(app.getPath('videos'), 'CineSnack')
  await fs.mkdir(dir, { recursive: true })
  const base =
    path
      .parse(input)
      .name.replace(/[^\w\- .()]+/g, '_')
      .slice(0, 80) || 'video'
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base}-share${i > 1 ? `-${i}` : ''}.mp4`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
}

function videoFilter(plan: EncodePlan): string {
  // Always resample to a constant rate. Screen recordings are variable frame rate, and the two
  // passes must see exactly the same frames or x264 aborts with "Incomplete MB-tree stats file".
  const parts: string[] = [`fps=${plan.fps ?? plan.effectiveFps}`]
  parts.push(`scale=${plan.width}:${plan.height}:flags=lanczos`, 'setsar=1', 'format=yuv420p')
  return parts.join(',')
}

function buildArgs(
  req: ExportRequest,
  info: ProbeResult,
  plan: EncodePlan,
  pass: 1 | 2,
  passLog: string,
  output: string
): string[] {
  const duration = req.endSec - req.startSec
  const args = ['-y', '-ss', req.startSec.toFixed(3), '-i', req.input, '-t', duration.toFixed(3)]
  const withAudio = pass === 2 && plan.audioKbps > 0

  const graph = [`[0:v:0]${videoFilter(plan)}[v]`]
  const mix = withAudio && req.mixAllAudio && info.audioTracks > 1
  if (mix) {
    const inputs = Array.from({ length: info.audioTracks }, (_, i) => `[0:a:${i}]`).join('')
    graph.push(`${inputs}amix=inputs=${info.audioTracks}:normalize=0:dropout_transition=0[a]`)
  }
  args.push('-filter_complex', graph.join(';'), '-map', '[v]', '-fps_mode', 'passthrough')

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    req.fast ? 'veryfast' : 'fast',
    '-profile:v',
    'high',
    '-b:v',
    `${plan.videoKbps}k`,
    // Limit peaks so web players can stream it without stalling, and put a keyframe every
    // 2 seconds so playback starts and seeks quickly.
    '-maxrate',
    `${Math.round(plan.videoKbps * 1.5)}k`,
    '-bufsize',
    `${Math.round(plan.videoKbps * 2)}k`,
    '-g',
    String(Math.max(1, Math.round(plan.effectiveFps * 2))),
    '-pass',
    String(pass),
    '-passlogfile',
    passLog
  )

  if (pass === 1) {
    args.push('-an', '-f', 'null', '-')
    return args
  }

  if (withAudio) {
    args.push(
      '-map',
      mix ? '[a]' : '0:a:0',
      '-c:a',
      'aac',
      '-b:a',
      `${plan.audioKbps}k`,
      '-ac',
      '2',
      '-ar',
      '48000'
    )
  } else {
    args.push('-an')
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', output)
  return args
}

/** Encode the trimmed clip so it lands at or under req.maxBytes. Returns final size. */
export async function encodeToFit(
  req: ExportRequest,
  info: ProbeResult,
  output: string,
  cb: EncodeCallbacks
): Promise<number> {
  const duration = req.endSec - req.startSec
  if (duration <= 0.05) {
    throw new Error('Selection is empty. Drag the handles apart.')
  }

  let plan = planEncode({
    durationSec: duration,
    srcWidth: info.width,
    srcHeight: info.height,
    srcFps: info.fps,
    hasAudio: info.audioTracks > 0,
    audioEnabled: req.audio,
    fps: req.fps,
    resolution: req.resolution,
    maxBytes: req.maxBytes
  })

  if (!plan.fits) {
    throw new Error('This clip is too long for the size limit. Trim it or pick a bigger limit.')
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinesnack-'))
  const passLog = path.join(tmpDir, 'pass')
  const partial = `${output}.partial`

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const suffix = attempt > 1 ? ` (retry ${attempt - 1}, squeezing harder)` : ''
      const report = (pass: 1 | 2) => (sec: number) => {
        const frac = Math.min(1, sec / duration)
        const p = pass === 1 ? frac * PASS1_WEIGHT : PASS1_WEIGHT + frac * (1 - PASS1_WEIGHT)
        cb.onProgress(p, `${pass === 1 ? 'Analyzing' : 'Encoding'}${suffix}`)
      }

      cb.onProgress(0, `Analyzing${suffix}`)
      await runFfmpeg(buildArgs(req, info, plan, 1, passLog, partial), {
        onTime: report(1),
        signal: cb.signal
      })
      await runFfmpeg(buildArgs(req, info, plan, 2, passLog, partial), {
        onTime: report(2),
        signal: cb.signal
      })

      const { size } = await fs.stat(partial)
      if (size <= req.maxBytes) {
        await fs.rename(partial, output)
        cb.onProgress(1, 'Done')
        return size
      }
      // Overshot: scale the video bitrate down proportionally with extra margin and retry.
      const factor = (req.maxBytes * 0.97) / size
      const total = (plan.videoKbps + plan.audioKbps) * factor
      plan = { ...plan, videoKbps: Math.max(30, Math.floor(total - plan.audioKbps)) }
    }
    throw new Error('Could not fit the video under the size limit. Try trimming it shorter.')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(partial, { force: true }).catch(() => {})
  }
}
