/**
 * Every user-facing action, its menu label and its default shortcut. The main process builds the
 * native menu and global shortcuts from this list; the renderer uses it for key handling and the
 * shortcuts editor. Users can rebind any of them (see `Bindings`).
 *
 * `accel` uses Electron accelerator syntax. Scopes:
 * - `global`: registered with the OS, works from any app (even when CineSnack is in the tray).
 * - `local`:  handled by the page, so it never fires while a dialog has focus. The menu shows it.
 * - default:  registered by the native menu while the window is focused.
 */
export type CommandId =
  | 'record'
  | 'record-focused'
  | 'open'
  | 'export'
  | 'cancel'
  | 'copy-output'
  | 'reveal-output'
  | 'close-video'
  | 'play'
  | 'step-back'
  | 'step-forward'
  | 'jump-back'
  | 'jump-forward'
  | 'go-start'
  | 'go-end'
  | 'mark-in'
  | 'mark-out'
  | 'go-in'
  | 'go-out'
  | 'clear-trim'
  | 'fps-30'
  | 'fps-60'
  | 'toggle-audio'
  | 'toggle-auto-export'
  | 'size-0'
  | 'size-1'
  | 'size-2'
  | 'shortcuts'

export type CommandGroup = 'Recording' | 'File' | 'Playback' | 'Trim' | 'Output' | 'Help'

export interface CommandDef {
  id: CommandId
  label: string
  group: CommandGroup
  accel?: string
  scope?: 'global' | 'local'
  /** Extra text for the shortcuts editor. */
  note?: string
}

export const COMMANDS: CommandDef[] = [
  {
    id: 'record-focused',
    label: 'Record Focused Window',
    group: 'Recording',
    accel: 'CmdOrCtrl+Alt+K',
    scope: 'global',
    note: 'Works from any app. Stops the recording if one is running.'
  },
  {
    id: 'record',
    label: 'Record Screen or Window…',
    group: 'Recording',
    accel: 'CmdOrCtrl+K',
    scope: 'global',
    note: 'Works from any app. Stops the recording if one is running.'
  },

  { id: 'open', label: 'Open Video…', group: 'File', accel: 'CmdOrCtrl+O' },
  { id: 'export', label: 'Export and Copy', group: 'File', accel: 'CmdOrCtrl+E' },
  { id: 'cancel', label: 'Cancel Export', group: 'File', accel: 'Escape', scope: 'local' },
  { id: 'copy-output', label: 'Copy Last Export', group: 'File', accel: 'CmdOrCtrl+Shift+C' },
  {
    id: 'reveal-output',
    label: 'Show Last Export in Folder',
    group: 'File',
    accel: 'CmdOrCtrl+Shift+F'
  },
  { id: 'close-video', label: 'Close Video', group: 'File', accel: 'CmdOrCtrl+W' },

  { id: 'play', label: 'Play / Pause', group: 'Playback', accel: 'Space', scope: 'local' },
  { id: 'step-back', label: 'Previous Frame', group: 'Playback', accel: 'Left', scope: 'local' },
  { id: 'step-forward', label: 'Next Frame', group: 'Playback', accel: 'Right', scope: 'local' },
  {
    id: 'jump-back',
    label: 'Back 1 Second',
    group: 'Playback',
    accel: 'Shift+Left',
    scope: 'local'
  },
  {
    id: 'jump-forward',
    label: 'Forward 1 Second',
    group: 'Playback',
    accel: 'Shift+Right',
    scope: 'local'
  },
  { id: 'go-start', label: 'Go to Start', group: 'Playback', accel: 'Home', scope: 'local' },
  { id: 'go-end', label: 'Go to End', group: 'Playback', accel: 'End', scope: 'local' },

  { id: 'mark-in', label: 'Set In Point', group: 'Trim', accel: 'I', scope: 'local' },
  { id: 'mark-out', label: 'Set Out Point', group: 'Trim', accel: 'O', scope: 'local' },
  { id: 'go-in', label: 'Go to In Point', group: 'Trim', accel: 'Shift+I', scope: 'local' },
  { id: 'go-out', label: 'Go to Out Point', group: 'Trim', accel: 'Shift+O', scope: 'local' },
  { id: 'clear-trim', label: 'Clear In and Out', group: 'Trim', accel: 'X', scope: 'local' },

  { id: 'fps-30', label: '30 fps', group: 'Output', accel: 'Alt+3', scope: 'local' },
  { id: 'fps-60', label: '60 fps', group: 'Output', accel: 'Alt+6', scope: 'local' },
  { id: 'toggle-audio', label: 'Include Audio', group: 'Output', accel: 'M', scope: 'local' },
  {
    id: 'toggle-auto-export',
    label: 'Auto-Export Recordings',
    group: 'Output',
    accel: 'A',
    scope: 'local',
    note: 'Export and copy as soon as a recording stops.'
  },
  { id: 'size-0', label: '10 MB Limit', group: 'Output', accel: '1', scope: 'local' },
  { id: 'size-1', label: '50 MB Limit', group: 'Output', accel: '2', scope: 'local' },
  { id: 'size-2', label: '500 MB Limit', group: 'Output', accel: '3', scope: 'local' },

  { id: 'shortcuts', label: 'Keyboard Shortcuts', group: 'Help', accel: 'F1' }
]

export const GROUPS: CommandGroup[] = ['Recording', 'File', 'Playback', 'Trim', 'Output', 'Help']

export const command = (id: CommandId): CommandDef => COMMANDS.find((c) => c.id === id)!

/** User overrides: an accelerator, or '' for "no shortcut". Missing ids use the default. */
export type BindingOverrides = Partial<Record<CommandId, string>>
/** Effective shortcut per command ('' = unbound). */
export type Bindings = Record<CommandId, string>

export function resolveBindings(overrides: BindingOverrides): Bindings {
  const out = {} as Bindings
  for (const c of COMMANDS) {
    out[c.id] = overrides[c.id] ?? c.accel ?? ''
  }
  return out
}

/** What the renderer needs to show and handle shortcuts. */
export interface KeyState {
  bindings: Bindings
  /** Global shortcuts the OS refused (usually taken by another app). */
  failed: CommandId[]
}

/** What the menu needs to know to grey out items and tick the right options. */
export interface UiState {
  hasFile: boolean
  exporting: boolean
  hasOutput: boolean
  fps: number
  audio: boolean
  audioAvailable: boolean
  sizeIndex: number
  /** Settings used when a recording is started from a global shortcut. */
  recordAudio: boolean
  /** Export and copy right after a recording stops, without showing the window. */
  autoExport: boolean
}

// ---------- accelerator <-> keyboard event ----------

/** Accelerator key name -> KeyboardEvent.code */
const KEY_TO_CODE: Record<string, string> = {
  Space: 'Space',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Escape: 'Escape',
  Enter: 'Enter',
  Backspace: 'Backspace',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '`': 'Backquote'
}
const CODE_TO_KEY = Object.fromEntries(Object.entries(KEY_TO_CODE).map(([k, v]) => [v, k]))

function codeForKey(key: string): string[] {
  if (/^[A-Z]$/.test(key)) {
    return [`Key${key}`]
  }
  if (/^\d$/.test(key)) {
    return [`Digit${key}`, `Numpad${key}`]
  }
  if (/^F\d{1,2}$/.test(key)) {
    return [key]
  }
  return KEY_TO_CODE[key] ? [KEY_TO_CODE[key]] : []
}

/** True when a keydown matches an accelerator exactly (no extra modifiers). */
export function matchesAccel(e: KeyboardEvent, accel: string, mac: boolean): boolean {
  if (!accel) {
    return false
  }
  const parts = accel.split('+')
  const key = parts.pop()!
  const mod = parts.includes('CmdOrCtrl')
  const want = {
    ctrl: (mod && !mac) || parts.includes('Ctrl'),
    meta: mod && mac,
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt')
  }
  if (
    e.ctrlKey !== want.ctrl ||
    e.metaKey !== want.meta ||
    e.shiftKey !== want.shift ||
    e.altKey !== want.alt
  ) {
    return false
  }
  // Physical keys, so Shift/Alt layouts still match.
  return codeForKey(key).includes(e.code)
}

/**
 * Turns a keydown into an accelerator for the shortcut editor. Returns null while only modifiers
 * are held, or for keys that can't be bound.
 */
export function accelFromEvent(e: KeyboardEvent, mac: boolean): string | null {
  let key: string | undefined
  if (/^Key[A-Z]$/.test(e.code)) {
    key = e.code.slice(3)
  } else if (/^(Digit|Numpad)\d$/.test(e.code)) {
    key = e.code.slice(-1)
  } else if (/^F\d{1,2}$/.test(e.code)) {
    key = e.code
  } else {
    key = CODE_TO_KEY[e.code]
  }
  if (!key) {
    return null
  }
  // On Windows/Linux the Super key is reserved by the OS, so don't offer it.
  if (!mac && e.metaKey) {
    return null
  }
  const parts: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) {
    parts.push('CmdOrCtrl')
  }
  if (mac && e.ctrlKey) {
    parts.push('Ctrl')
  }
  if (e.altKey) {
    parts.push('Alt')
  }
  if (e.shiftKey) {
    parts.push('Shift')
  }
  parts.push(key)
  return parts.join('+')
}

/** Global shortcuts need a modifier (or a function key) so they don't swallow normal typing. */
export function validForScope(accel: string, scope: CommandDef['scope']): boolean {
  if (scope !== 'global') {
    return true
  }
  const parts = accel.split('+')
  const key = parts[parts.length - 1]
  return parts.some((p) => p === 'CmdOrCtrl' || p === 'Alt' || p === 'Ctrl') || /^F\d/.test(key)
}

/** Human-readable shortcut for the current platform: "Ctrl+Shift+C" or "⇧⌘C". */
export function prettyAccel(accel: string, mac: boolean): string {
  if (!accel) {
    return ''
  }
  const names: Record<string, [string, string]> = {
    CmdOrCtrl: ['Ctrl', '⌘'],
    Ctrl: ['Ctrl', '⌃'],
    Shift: ['Shift', '⇧'],
    Alt: ['Alt', '⌥'],
    Left: ['←', '←'],
    Right: ['→', '→'],
    Up: ['↑', '↑'],
    Down: ['↓', '↓'],
    Escape: ['Esc', 'Esc'],
    PageUp: ['PgUp', 'PgUp'],
    PageDown: ['PgDn', 'PgDn'],
    Delete: ['Del', 'Del'],
    Backspace: ['Backspace', '⌫']
  }
  const mapped = accel.split('+').map((p) => names[p]?.[mac ? 1 : 0] ?? p)
  return mac ? mapped.join('') : mapped.join('+')
}
