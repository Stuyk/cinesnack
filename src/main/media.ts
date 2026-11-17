import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runFfmpeg } from './ffmpeg'

/** Grab `count` evenly spaced small JPEG frames for the timeline filmstrip. */
export async function thumbnails(
  input: string,
  durationSec: number,
  count = 12
): Promise<string[]> {
  const times = Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * durationSec)
  const results: string[] = new Array(count).fill('')
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < times.length) {
      const i = next++
      try {
        const buf = await runFfmpeg([
          '-ss',
          times[i].toFixed(2),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          'scale=-2:90',
          '-f',
          'image2pipe',
          '-c:v',
          'mjpeg',
          '-q:v',
          '6',
          '-'
        ])
        if (buf.length) {
          results[i] = `data:image/jpeg;base64,${buf.toString('base64')}`
        }
      } catch {
        // A missing frame just leaves a gap in the strip.
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  return results
}

let proxyDir: string | null = null

/** Low-res H.264 copy that Chromium can always play, used only for in-app preview. */
export async function makePreviewProxy(
  input: string,
  durationSec: number,
  onProgress: (p: number) => void,
  signal: AbortSignal
): Promise<string> {
  proxyDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'cinesnack-preview-'))
  const out = path.join(proxyDir, `${Date.now()}.mp4`)
  await runFfmpeg(
    [
      '-y',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale='min(854,iw)':-2,format=yuv420p",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '30',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      out
    ],
    { onTime: (t) => onProgress(Math.min(1, t / durationSec)), signal }
  )
  return out
}

export async function cleanupPreviews(): Promise<void> {
  if (proxyDir) {
    await fs.rm(proxyDir, { recursive: true, force: true }).catch(() => {})
  }
}
