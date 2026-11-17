import { onCleanup, onMount, type JSX } from 'solid-js'
import X from 'lucide-solid/icons/x'

/**
 * Modal dialog: traps Tab inside, closes on Escape or a click on the backdrop, and puts focus
 * back where it was when it closes.
 */
export default function Dialog(props: {
  title: string
  onClose: () => void
  width?: string
  footer?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  let box!: HTMLDivElement
  const previous = document.activeElement as HTMLElement | null

  const focusables = (): HTMLElement[] =>
    Array.from(
      box.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    )

  onMount(() => {
    const first = box.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0]
    first?.focus()
  })
  onCleanup(() => previous?.focus?.())

  return (
    <div
      class="fixed inset-0 z-40 bg-[#05080d]/70 flex items-center justify-center p-6"
      onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        class="panel shadow-[0_24px_60px_rgba(0,0,0,0.5)] w-full max-h-full flex flex-col"
        style={{ 'max-width': props.width ?? '760px' }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
          } else if (e.key === 'Tab') {
            const list = focusables()
            if (!list.length) {
              return
            }
            const i = list.indexOf(document.activeElement as HTMLElement)
            if (e.shiftKey && i <= 0) {
              e.preventDefault()
              list[list.length - 1].focus()
            } else if (!e.shiftKey && i === list.length - 1) {
              e.preventDefault()
              list[0].focus()
            }
          }
        }}
      >
        <div class="panel-head h-9! text-[13px]! text-fg!">
          <h2 id="dialog-title" class="flex-1 font-semibold">
            {props.title}
          </h2>
          <button
            class="btn btn-ghost btn-icon h-6! w-6!"
            onClick={props.onClose}
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto">{props.children}</div>
        {props.footer && (
          <div class="flex items-center gap-2 px-3 py-2.5 border-t border-line">{props.footer}</div>
        )}
      </div>
    </div>
  )
}
