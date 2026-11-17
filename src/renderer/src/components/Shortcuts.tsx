import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Dialog from './Dialog'
import {
  accelFromEvent,
  command,
  COMMANDS,
  GROUPS,
  prettyAccel,
  type CommandId
} from '../../../shared/commands'
import { isMac, keyState, setKeyState } from '../keys'

/**
 * Keyboard shortcut list and editor. Click a shortcut, press the new keys. Esc cancels,
 * Backspace or Delete removes the shortcut.
 */
export default function Shortcuts(props: { onClose: () => void }): JSX.Element {
  const [editing, setEditing] = createSignal<CommandId | null>(null)
  const [message, setMessage] = createSignal<{ text: string; bad?: boolean } | null>(null)

  const stopEditing = (): void => {
    if (editing()) {
      window.api.setCapturingKeys(false)
    }
    setEditing(null)
  }
  onCleanup(stopEditing)

  const begin = (id: CommandId): void => {
    window.api.setCapturingKeys(true)
    setEditing(id)
    setMessage(null)
  }

  const apply = async (id: CommandId, accel: string | null): Promise<void> => {
    stopEditing()
    const res = await window.api.setKey(id, accel)
    setKeyState(res.keys)
    const label = command(id).label
    if (!res.ok) {
      setMessage({ text: res.error ?? 'Could not set that shortcut.', bad: true })
    } else if (res.cleared) {
      setMessage({ text: `${label} set. Removed it from ${command(res.cleared).label}.` })
    } else {
      setMessage({ text: accel === '' ? `${label} has no shortcut now.` : `${label} updated.` })
    }
  }

  const onCaptureKey = (id: CommandId) => (e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      stopEditing()
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      void apply(id, '')
      return
    }
    if (e.key === 'Tab') {
      stopEditing()
      return
    }
    const accel = accelFromEvent(e, isMac)
    if (accel) {
      void apply(id, accel)
    }
  }

  const resetAll = async (): Promise<void> => {
    stopEditing()
    setKeyState(await window.api.resetKeys())
    setMessage({ text: 'All shortcuts are back to their defaults.' })
  }

  return (
    <Dialog
      title="Keyboard Shortcuts"
      onClose={() => (editing() ? stopEditing() : props.onClose())}
      width="780px"
      footer={
        <>
          <span
            class="text-[12px] flex-1"
            classList={{ 'text-bad': message()?.bad, 'text-fg-2': !message()?.bad }}
            role="status"
            aria-live="polite"
          >
            {message()?.text ??
              'Click a shortcut and press new keys. Esc cancels, Backspace removes it.'}
          </span>
          <button class="btn" onClick={resetAll}>
            <RotateCcw size={13} /> Reset All
          </button>
          <button class="btn btn-primary" onClick={props.onClose}>
            Done
          </button>
        </>
      }
    >
      <div class="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
        <For each={GROUPS}>
          {(g) => (
            <section class={g === 'Recording' ? 'col-span-2' : ''}>
              <h3 class="text-[12px] font-semibold text-fg-2 mb-1.5">
                {g}
                {g === 'Recording' && (
                  <span class="font-normal text-fg-3">
                    {' '}
                    · work from any app; press either one again to stop
                  </span>
                )}
              </h3>
              <div
                class="flex flex-col"
                classList={{ 'grid! grid-cols-2 gap-x-6': g === 'Recording' }}
              >
                <For each={COMMANDS.filter((c) => c.group === g)}>
                  {(c) => {
                    const accel = (): string => keyState().bindings[c.id]
                    const isDefault = (): boolean => accel() === (c.accel ?? '')
                    const failed = (): boolean => keyState().failed.includes(c.id)
                    return (
                      <div class="flex items-center gap-2 py-[3px] border-b border-line/60 min-h-[30px]">
                        <span class="flex-1 text-[13px]">{c.label}</span>
                        <Show when={!isDefault() && editing() !== c.id}>
                          <button
                            class="btn btn-ghost btn-icon h-6! w-6! text-fg-3"
                            title={`Reset to ${prettyAccel(c.accel ?? '', isMac) || 'none'}`}
                            aria-label={`Reset ${c.label} shortcut`}
                            onClick={() => void apply(c.id, null)}
                          >
                            <RotateCcw size={12} />
                          </button>
                        </Show>
                        <button
                          class="min-w-[92px] h-6 px-2 rounded-[4px] border text-[12px] mono text-right"
                          classList={{
                            'border-accent bg-accent-soft text-accent-fg': editing() === c.id,
                            'border-transparent hover:border-line-strong hover:bg-hover':
                              editing() !== c.id
                          }}
                          aria-label={`${c.label}: ${prettyAccel(accel(), isMac) || 'no shortcut'}. Press to change.`}
                          ref={(el) => {
                            // Focus follows the row being edited so the next keypress lands here.
                            queueMicrotask(() => editing() === c.id && el.focus())
                          }}
                          onClick={() => (editing() === c.id ? stopEditing() : begin(c.id))}
                          onKeyDown={(e) => editing() === c.id && onCaptureKey(c.id)(e)}
                          onBlur={() => editing() === c.id && stopEditing()}
                        >
                          <Show
                            when={editing() !== c.id}
                            fallback={<span class="font-sans">Press keys…</span>}
                          >
                            <Show
                              when={accel()}
                              fallback={<span class="text-fg-3 font-sans">None</span>}
                            >
                              <kbd classList={{ 'line-through! text-bad!': failed() }}>
                                {prettyAccel(accel(), isMac)}
                              </kbd>
                            </Show>
                          </Show>
                        </button>
                        <Show when={failed()}>
                          <span class="sr-only">Taken by another app</span>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
              <Show
                when={
                  g === 'Recording' &&
                  keyState().failed.some((id) => command(id).group === 'Recording')
                }
              >
                <p class="text-[12px] text-bad mt-1.5">
                  A struck-out shortcut is taken by another app. Pick different keys.
                </p>
              </Show>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  )
}
