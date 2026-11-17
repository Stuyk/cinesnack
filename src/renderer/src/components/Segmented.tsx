import { For, type JSX } from 'solid-js'

export interface SegmentOption<T> {
  value: T
  label: string
  disabled?: boolean
  title?: string
}

/**
 * Joined toggle buttons that behave as a radio group: Tab focuses the selected option,
 * arrow keys move the selection.
 */
export default function Segmented<T>(props: {
  options: SegmentOption<T>[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
  label: string
}): JSX.Element {
  let root!: HTMLDivElement

  const move = (dir: 1 | -1): void => {
    const opts = props.options.filter((o) => !o.disabled)
    const i = opts.findIndex((o) => o.value === props.value)
    const next = opts[(i + dir + opts.length) % opts.length]
    if (next) {
      props.onChange(next.value)
      queueMicrotask(() => root.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
    }
  }

  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={props.label}
      class="flex h-7 rounded-[5px] border border-line-strong bg-app p-[2px] gap-[2px]"
      classList={{ 'opacity-45': props.disabled }}
      onKeyDown={(e) => {
        if (props.disabled) {
          return
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          move(1)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          move(-1)
        }
      }}
    >
      <For each={props.options}>
        {(opt) => {
          const on = (): boolean => props.value === opt.value
          return (
            <button
              type="button"
              role="radio"
              aria-checked={on()}
              tabIndex={on() ? 0 : -1}
              title={opt.title}
              disabled={props.disabled || opt.disabled}
              onClick={() => props.onChange(opt.value)}
              class="flex-1 min-w-0 px-2 text-[12px] font-medium whitespace-nowrap rounded-[3px] transition-colors"
              classList={{
                'bg-accent-soft text-accent-fg shadow-[inset_0_0_0_1px_var(--color-accent)]': on(),
                'text-fg-2 hover:bg-hover hover:text-fg': !on()
              }}
            >
              {opt.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}
