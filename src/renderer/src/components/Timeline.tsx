import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { formatTime } from '../../../shared/plan'

const MIN_LEN = 0.2
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

type DragKind = 'start' | 'end' | 'seek'

/** Ruler + filmstrip with in/out handles. Handles are sliders: arrows nudge by a frame. */
export default function Timeline(props: {
  duration: number
  fps: number
  start: number
  end: number
  current: number
  thumbs: string[]
  disabled?: boolean
  onTrim: (start: number, end: number) => void
  onSeek: (t: number) => void
  onDragStart?: () => void
}): JSX.Element {
  let area!: HTMLDivElement
  const [width, setWidth] = createSignal(800)

  onMount(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(area)
    onCleanup(() => ro.disconnect())
  })

  const pct = (t: number): string => `${(t / props.duration) * 100}%`

  // Major ticks at least ~90px apart, four minor ticks between.
  const ticks = createMemo(() => {
    const d = props.duration
    const step = TICK_STEPS.find((s) => (s / d) * width() >= 90) ?? 600
    const out: { t: number; major: boolean }[] = []
    const minor = step / 5
    for (let t = 0; t <= d + 1e-6; t += minor) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
      out.push({ t, major })
    }
    return out
  })

  const timeAt = (clientX: number): number => {
    const r = area.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - r.left, 0), r.width)
    return (x / r.width) * props.duration
  }

  const apply = (kind: DragKind, t: number): void => {
    if (kind === 'start') {
      const s = Math.max(0, Math.min(t, props.end - MIN_LEN))
      props.onTrim(s, props.end)
      props.onSeek(s)
    } else if (kind === 'end') {
      const e = Math.min(props.duration, Math.max(t, props.start + MIN_LEN))
      props.onTrim(props.start, e)
      props.onSeek(e)
    } else {
      props.onSeek(Math.max(0, Math.min(props.duration, t)))
    }
  }

  const begin = (kind: DragKind) => (ev: PointerEvent) => {
    if (props.disabled || ev.button !== 0) {
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    props.onDragStart?.()
    const el = ev.currentTarget as HTMLElement
    el.setPointerCapture(ev.pointerId)
    if (kind === 'seek') {
      apply(kind, timeAt(ev.clientX))
    } else {
      el.focus()
    }
    const move = (e: PointerEvent): void => apply(kind, timeAt(e.clientX))
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const nudge = (kind: 'start' | 'end') => (e: KeyboardEvent) => {
    const frame = 1 / (props.fps || 30)
    const cur = kind === 'start' ? props.start : props.end
    let t: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      t = cur - (e.shiftKey ? 1 : frame)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      t = cur + (e.shiftKey ? 1 : frame)
    } else if (e.key === 'PageDown') {
      t = cur - 5
    } else if (e.key === 'PageUp') {
      t = cur + 5
    } else if (e.key === 'Home') {
      t = kind === 'start' ? 0 : props.start + MIN_LEN
    } else if (e.key === 'End') {
      t = kind === 'start' ? props.end - MIN_LEN : props.duration
    }
    if (t !== null && !props.disabled) {
      e.preventDefault()
      e.stopPropagation()
      apply(kind, t)
    }
  }

  const Handle = (p: { kind: 'start' | 'end' }): JSX.Element => {
    const value = (): number => (p.kind === 'start' ? props.start : props.end)
    return (
      <div
        role="slider"
        tabIndex={props.disabled ? -1 : 0}
        aria-label={p.kind === 'start' ? 'In point' : 'Out point'}
        aria-valuemin={0}
        aria-valuemax={Math.round(props.duration * 100) / 100}
        aria-valuenow={Math.round(value() * 100) / 100}
        aria-valuetext={formatTime(value())}
        aria-disabled={props.disabled}
        title={`${p.kind === 'start' ? 'In point' : 'Out point'} · drag, or focus and use arrow keys`}
        onPointerDown={begin(p.kind)}
        onKeyDown={nudge(p.kind)}
        class="group absolute top-0 bottom-0 w-3 z-20 cursor-ew-resize flex items-center justify-center bg-accent hover:bg-accent-fg focus-visible:outline-offset-2"
        classList={{
          'rounded-l-[4px]': p.kind === 'start',
          'rounded-r-[4px]': p.kind === 'end'
        }}
        style={{
          left: pct(value()),
          transform: p.kind === 'start' ? 'translateX(-100%)' : 'none'
        }}
      >
        <div class="w-[2px] h-5 rounded bg-[#0b2a4f]" />
      </div>
    )
  }

  return (
    <div class="px-3 select-none" classList={{ 'opacity-60': props.disabled }}>
      <div ref={area} class="relative">
        {/* Ruler */}
        <div
          onPointerDown={begin('seek')}
          class="relative h-[22px] border-b border-line-strong"
          aria-hidden="true"
        >
          <For each={ticks()}>
            {(tk) => (
              <div class="absolute bottom-0" style={{ left: pct(tk.t) }}>
                <div
                  class="w-px bg-fg-3"
                  classList={{ 'h-2': tk.major, 'h-1 opacity-60': !tk.major }}
                />
                <Show when={tk.major}>
                  <span class="absolute bottom-[9px] left-1 mono text-[11px] text-fg-3 whitespace-nowrap">
                    {formatTime(tk.t)}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>

        {/* Track */}
        <div
          onPointerDown={begin('seek')}
          class="relative h-14 mt-1.5 rounded-[4px] bg-base border border-line overflow-visible"
        >
          <div class="absolute inset-0 flex overflow-hidden rounded-[3px]">
            <For each={props.thumbs}>
              {(src) => (
                <div
                  class="flex-1 h-full bg-raised bg-cover bg-center border-r border-base/70"
                  style={{ 'background-image': src ? `url(${src})` : 'none' }}
                />
              )}
            </For>
          </div>

          {/* Cut regions */}
          <div
            class="absolute inset-y-0 left-0 bg-base/80 rounded-l-[3px]"
            style={{ width: pct(props.start) }}
          />
          <div
            class="absolute inset-y-0 right-0 bg-base/80 rounded-r-[3px]"
            style={{ left: pct(props.end) }}
          />

          {/* Kept range */}
          <div
            class="absolute top-0 bottom-0 border-y-2 border-accent pointer-events-none z-10"
            style={{ left: pct(props.start), width: pct(props.end - props.start) }}
          />

          <Handle kind="start" />
          <Handle kind="end" />
        </div>

        {/* Playhead across ruler and track */}
        <div
          class="absolute top-0 bottom-0 w-px bg-fg z-30 pointer-events-none"
          style={{ left: pct(props.current) }}
          aria-hidden="true"
        >
          <div class="absolute top-0 -left-[5px] w-[11px] h-[12px] bg-fg [clip-path:polygon(0_0,100%_0,100%_60%,50%_100%,0_60%)]" />
        </div>
      </div>
    </div>
  )
}
