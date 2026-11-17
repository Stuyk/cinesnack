import { createSignal } from 'solid-js'
import { prettyAccel, resolveBindings, type CommandId, type KeyState } from '../../shared/commands'

export const isMac = navigator.userAgent.includes('Mac')

/** Current shortcuts, kept in sync with the main process (which owns and saves them). */
const [keyState, setKeyState] = createSignal<KeyState>({
  bindings: resolveBindings({}),
  failed: []
})
export { keyState, setKeyState }

let started = false
/** Load shortcuts once and follow changes made in any window. */
export function initKeys(): void {
  if (started) {
    return
  }
  started = true
  void window.api.appInfo().then((i) => setKeyState(i.keys))
  window.api.onKeysChanged(setKeyState)
}

export const accelOf = (id: CommandId): string => keyState().bindings[id] ?? ''
/** Display form, e.g. "Ctrl+K"; empty when unbound or refused by the OS. */
export const keyOf = (id: CommandId): string =>
  keyState().failed.includes(id) ? '' : prettyAccel(accelOf(id), isMac)
/** Tooltip text with the shortcut appended when there is one. */
export const tip = (label: string, id: CommandId): string =>
  keyOf(id) ? `${label} (${keyOf(id)})` : label
