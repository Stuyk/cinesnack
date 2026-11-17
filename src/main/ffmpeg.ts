import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import type { ProbeResult, WarmupResult } from '../shared/types'

export function getFfmpegPath(): string {
  const p = ffmpegStatic as unknown as string
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
}

function parseClock(h: string, m: string, s: string): number {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s)
}

export interface RunOptions {
  /** Called with seconds of output processed so far. */
  onTime?: (sec: number) => void
  signal?: AbortSignal
}

/** Run ffmpeg, resolving with stdout bytes. Rejects with the tail of stderr on failure. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      return reject(new Error('cancelled'))
    }
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-nostdin', ...args], {
      windowsHide: true
    })
    const out: Buffer[] = []
    let err = ''
    const onAbort = (): void => {
      proc.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => {
      const text = c.toString()
      err = (err + text).slice(-32000)
      if (opts.onTime) {
        const matches = [...text.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)]
        const last = matches[matches.length - 1]
        if (last) {
          opts.onTime(parseClock(last[1], last[2], last[3]))
        }
      }
    })
    proc.on('error', (e) => reject(new Error(`Could not start ffmpeg: ${e.message}`)))
    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) {
        return reject(new Error('cancelled'))
      }
      if (code === 0) {
        resolve(Buffer.concat(out))
      } else {
        reject(new Error(summarizeError(err) || `ffmpeg exited ${code}`))
      }
    })
  })
}

/**
 * Pull the lines that explain a failure out of ffmpeg's stderr. The tail is usually encoder
 * statistics and "Conversion failed!", which say nothing useful on their own.
 */
export function summarizeError(stderr: string): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame|size)=/.test(l))
  const useful = lines.filter(
    (l) =>
      /error|invalid|incomplete|failed|cannot|could not|unable|not found|no such|denied|unsupported/i.test(
        l
      ) && !/^Conversion failed!?$/.test(l)
  )
  return (useful.length ? useful.slice(0, 4) : lines.slice(-4)).join('\n')
}

/** Probe with `ffmpeg -i` (ffmpeg-static ships no ffprobe) and parse stderr. */
export function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-nostdin', '-i', filePath], {
      windowsHide: true
    })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', (e) => reject(new Error(`Could not start ffmpeg: ${e.message}`)))
    proc.on('close', () => {
      try {
        resolve(parseProbe(stderr))
      } catch (e) {
        reject(e)
      }
    })
  })
}

export function parseProbe(stderr: string): ProbeResult {
  const lines = stderr.split(/\r?\n/)
  const dur = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
  const durationSec = dur ? parseClock(dur[1], dur[2], dur[3]) : 0

  const videoIdx = lines.findIndex(
    (l) => /Stream #\d+:\d+.*: Video:/.test(l) && !/attached pic/.test(l)
  )
  if (videoIdx === -1) {
    throw new Error('No video stream found in this file.')
  }
  const videoLine = lines[videoIdx]
  const codec = videoLine.match(/Video:\s*([^\s,]+)/)?.[1] ?? 'unknown'
  const dim = videoLine.match(/,\s*(\d{2,5})x(\d{2,5})/)
  let width = dim ? parseInt(dim[1], 10) : 1280
  let height = dim ? parseInt(dim[2], 10) : 720
  const fpsMatch = videoLine.match(/([\d.]+)\s*fps/) ?? videoLine.match(/([\d.]+)\s*tbr/)
  const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30

  // Rotation side-data lives on the lines just after the stream line.
  const sideData = lines.slice(videoIdx + 1, videoIdx + 8).join('\n')
  const rot = sideData.match(/rotation of (-?[\d.]+) degrees/)
  if (rot && Math.abs(Math.round(parseFloat(rot[1]))) % 180 === 90) {
    ;[width, height] = [height, width]
  }

  const audioTracks = lines.filter((l) => /Stream #\d+:\d+.*: Audio:/.test(l)).length
  if (!durationSec) {
    throw new Error('Could not read the length of this video.')
  }

  return { durationSec, width, height, fps, audioTracks, codec }
}

let warm: Promise<WarmupResult> | null = null

/**
 * Check the bundled ffmpeg exists and runs, once per launch. Running it also pulls the binary
 * into the OS file cache, so the first real probe/encode starts quickly.
 */
export function warmup(): Promise<WarmupResult> {
  warm ??= (async (): Promise<WarmupResult> => {
    const bin = getFfmpegPath()
    try {
      await fs.access(bin)
    } catch {
      return {
        ok: false,
        error: `ffmpeg is missing from this install (${bin}). Reinstall CineSnack.`
      }
    }
    return new Promise((resolve) => {
      execFile(
        bin,
        ['-hide_banner', '-version'],
        { timeout: 20000, windowsHide: true },
        (err, out) => {
          if (err) {
            resolve({ ok: false, error: `ffmpeg could not start: ${err.message}` })
            return
          }
          resolve({ ok: true, version: String(out).match(/ffmpeg version (\S+)/)?.[1] })
        }
      )
    })
  })()
  // Don't cache a failure: "Try Again" should really try again.
  void warm.then((r) => {
    if (!r.ok) {
      warm = null
    }
  })
  return warm
}
