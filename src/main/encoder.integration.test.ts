/**
 * Real ffmpeg encodes. Slow, so opt-in:  CINESNACK_INTEGRATION=1 npx vitest run encoder.integration
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinesnack-it-'))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmp } }))

const { runFfmpeg, probe } = await import('./ffmpeg')
const { encodeToFit, outputPathFor } = await import('./encoder')

const MB = 1024 * 1024
const run = process.env.CINESNACK_INTEGRATION ? describe : describe.skip

run('encodeToFit', () => {
  const noisy = path.join(tmp, 'noisy.mkv')
  const portrait = path.join(tmp, 'portrait.mov')
  const vfr = path.join(tmp, 'vfr-recording.mp4')

  beforeAll(async () => {
    // High-entropy 1080p60 with TWO audio tracks: worst case for rate control.
    await runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=60:duration=20,noise=alls=40:allf=t',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=20',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=duration=20:amplitude=0.3',
      '-map',
      '0',
      '-map',
      '1',
      '-map',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-c:a',
      'flac',
      noisy
    ])
    await runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=720x1280:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      portrait
    ])
    // Same shape as a CineSnack screen recording: variable frame rate, fragmented MP4, AAC.
    await runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=60:duration=8,setpts=PTS+0.004*sin(N*1.7)/TB',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=8',
      '-fps_mode',
      'passthrough',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      vfr
    ])
  }, 120_000)

  it('fits a noisy 1080p60 clip in 10 MB with audio', async () => {
    const info = await probe(noisy)
    expect(info.audioTracks).toBe(2)
    const out = await outputPathFor(noisy)
    const size = await encodeToFit(
      {
        input: noisy,
        startSec: 2,
        endSec: 17,
        fps: 60,
        audio: true,
        mixAllAudio: true,
        resolution: 'auto',
        maxBytes: 10 * MB
      },
      info,
      out,
      { onProgress: () => {}, signal: new AbortController().signal }
    )
    expect(size).toBeLessThanOrEqual(10 * MB)
    expect(size).toBeGreaterThan(7 * MB) // used the budget, not wasted it
    const outInfo = await probe(out)
    expect(outInfo.audioTracks).toBe(1)
    expect(Math.abs(outInfo.durationSec - 15)).toBeLessThan(0.3)
    expect(Math.round(outInfo.fps)).toBe(60)
  }, 600_000)

  it('handles variable frame rate screen recordings (two passes see the same frames)', async () => {
    const info = await probe(vfr)
    const out = await outputPathFor(vfr)
    const size = await encodeToFit(
      {
        input: vfr,
        startSec: 0,
        endSec: info.durationSec,
        fps: 60,
        audio: true,
        mixAllAudio: false,
        resolution: 'auto',
        maxBytes: 10 * MB
      },
      info,
      out,
      { onProgress: () => {}, signal: new AbortController().signal }
    )
    expect(size).toBeLessThanOrEqual(10 * MB)
    expect((await probe(out)).audioTracks).toBe(1)
  }, 300_000)

  it('fast preset (auto-export) still fits the limit with audio', async () => {
    const info = await probe(noisy)
    const out = await outputPathFor(noisy)
    const t0 = Date.now()
    const size = await encodeToFit(
      {
        input: noisy,
        startSec: 2,
        endSec: 17,
        fps: 60,
        audio: true,
        mixAllAudio: false,
        resolution: 'auto',
        maxBytes: 10 * MB,
        fast: true
      },
      info,
      out,
      { onProgress: () => {}, signal: new AbortController().signal }
    )
    console.log(
      `fast preset: ${(size / MB).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    )
    expect(size).toBeLessThanOrEqual(10 * MB)
    expect((await probe(out)).audioTracks).toBe(1)
  }, 600_000)

  it('keeps portrait orientation, 30fps cap, and mute works', async () => {
    const info = await probe(portrait)
    const out = await outputPathFor(portrait)
    await encodeToFit(
      {
        input: portrait,
        startSec: 0,
        endSec: info.durationSec,
        fps: 60,
        audio: false,
        mixAllAudio: false,
        resolution: 480,
        maxBytes: 50 * MB
      },
      info,
      out,
      { onProgress: () => {}, signal: new AbortController().signal }
    )
    const outInfo = await probe(out)
    expect([outInfo.width, outInfo.height]).toEqual([480, 854])
    expect(outInfo.audioTracks).toBe(0)
    expect(Math.round(outInfo.fps)).toBe(30)
  }, 300_000)
})
