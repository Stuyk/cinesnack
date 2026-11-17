import { describe, expect, it } from 'vitest'
import { planEncode, SIZE_PRESETS, type PlanInput } from './plan'

const MB50 = SIZE_PRESETS[1].bytes
const base: PlanInput = {
  durationSec: 60,
  srcWidth: 1920,
  srcHeight: 1080,
  srcFps: 60,
  hasAudio: true,
  audioEnabled: true,
  fps: 60,
  resolution: 'auto',
  maxBytes: MB50
}

describe('planEncode', () => {
  it('never budgets more than the size limit', () => {
    for (const durationSec of [1, 5, 30, 60, 300, 1800]) {
      for (const maxBytes of SIZE_PRESETS.map((p) => p.bytes)) {
        const p = planEncode({ ...base, durationSec, maxBytes })
        if (p.fits) {
          expect(p.estimatedBytes).toBeLessThanOrEqual(maxBytes)
        } else {
          expect(durationSec).toBeGreaterThan(1000)
        }
      }
    }
  })

  it('drops resolution for long 60fps clips and keeps full res for short ones', () => {
    expect(planEncode({ ...base, durationSec: 10 }).height).toBe(1080)
    expect(planEncode({ ...base, durationSec: 120 }).height).toBeLessThan(1080)
  })

  it('does not upscale or invent frames', () => {
    const p = planEncode({ ...base, srcWidth: 640, srcHeight: 360, srcFps: 30, resolution: 1080 })
    expect([p.width, p.height]).toEqual([640, 360])
    expect(p.fps).toBe(30)
    expect(p.effectiveFps).toBe(30)
  })

  it('caps to 30fps when asked', () => {
    expect(planEncode({ ...base, fps: 30 }).fps).toBe(30)
  })

  it('handles portrait video using the short side', () => {
    const p = planEncode({ ...base, srcWidth: 1080, srcHeight: 1920, resolution: 720 })
    expect([p.width, p.height]).toEqual([720, 1280])
  })

  it('gives video all the bits when audio is off or missing', () => {
    expect(planEncode({ ...base, audioEnabled: false }).audioKbps).toBe(0)
    expect(planEncode({ ...base, hasAudio: false }).audioKbps).toBe(0)
    expect(planEncode(base).audioKbps).toBeGreaterThan(0)
  })

  it('snaps odd screen-recording rates to a standard rate', () => {
    expect(planEncode({ ...base, srcFps: 59.83 }).fps).toBe(60)
    expect(planEncode({ ...base, srcFps: 29.9, fps: 60 }).fps).toBe(30)
  })

  it('keeps short clips streamable: auto stays <= 1080p and ~12 Mbps at 1080p60', () => {
    const p = planEncode({ ...base, srcWidth: 2560, srcHeight: 1440, durationSec: 7.7 })
    expect(p.height).toBe(1080)
    expect(p.videoKbps).toBeLessThanOrEqual(13000)
    expect(p.quality).toBe('great')
  })

  it('uses decimal megabytes so files are under the limit by any definition', () => {
    expect(SIZE_PRESETS[1].bytes).toBe(50_000_000)
  })

  it('always produces even dimensions', () => {
    const p = planEncode({ ...base, srcWidth: 1366, srcHeight: 767, resolution: 480 })
    expect(p.width % 2).toBe(0)
    expect(p.height % 2).toBe(0)
  })
})
