/**
 * Windows/macOS system-audio capture. Chromium's display-media loopback gives us the device mix;
 * we stream it to the main process as interleaved s16le 48 kHz stereo, which ffmpeg muxes in.
 * (Linux uses `parec` in the main process instead and never triggers this.)
 */
let stop: (() => void) | null = null

export async function startLoopback(): Promise<void> {
  if (stop) {
    return
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch {
    return // main process times out and records without audio
  }
  stream.getVideoTracks().forEach((t) => t.stop())
  if (!stream.getAudioTracks().length) {
    return
  }

  const ctx = new AudioContext({ sampleRate: 48000 })
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(2048, 2, 2)
  const mute = ctx.createGain()
  mute.gain.value = 0

  proc.onaudioprocess = (e) => {
    const l = e.inputBuffer.getChannelData(0)
    const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l
    const out = new Int16Array(l.length * 2)
    for (let i = 0; i < l.length; i++) {
      out[i * 2] = Math.max(-1, Math.min(1, l[i])) * 0x7fff
      out[i * 2 + 1] = Math.max(-1, Math.min(1, r[i])) * 0x7fff
    }
    window.api.pushAudio(new Uint8Array(out.buffer))
  }
  src.connect(proc)
  proc.connect(mute)
  mute.connect(ctx.destination)

  stop = () => {
    proc.disconnect()
    src.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    stop = null
  }
}

export function stopLoopback(): void {
  stop?.()
}
