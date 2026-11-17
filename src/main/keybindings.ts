import { app, globalShortcut } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  command,
  COMMANDS,
  resolveBindings,
  validForScope,
  type BindingOverrides,
  type Bindings,
  type CommandId,
  type KeyState
} from '../shared/commands'

const file = (): string => path.join(app.getPath('userData'), 'keybindings.json')

/**
 * User shortcut overrides, saved to userData/keybindings.json. Also owns the OS-level global
 * shortcuts, so a rebind takes effect immediately.
 */
export class Keybindings {
  private overrides: BindingOverrides = {}
  private failed: CommandId[] = []

  constructor(private onGlobal: (id: CommandId) => void) {
    try {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
      const known = new Set(COMMANDS.map((c) => c.id))
      for (const [k, v] of Object.entries(raw)) {
        if (known.has(k as CommandId) && typeof v === 'string') {
          this.overrides[k as CommandId] = v
        }
      }
    } catch {
      /* no file yet, or unreadable: defaults */
    }
  }

  get bindings(): Bindings {
    return resolveBindings(this.overrides)
  }

  get state(): KeyState {
    return { bindings: this.bindings, failed: [...this.failed] }
  }

  /** (Re)register every global shortcut. Returns the ids the OS refused. */
  registerGlobals(): CommandId[] {
    globalShortcut.unregisterAll()
    this.failed = []
    const b = this.bindings
    for (const c of COMMANDS.filter((c) => c.scope === 'global')) {
      const accel = b[c.id]
      if (!accel) {
        continue
      }
      let ok = false
      try {
        ok = globalShortcut.register(accel, () => this.onGlobal(c.id))
      } catch {
        ok = false
      }
      if (!ok) {
        this.failed.push(c.id)
      }
    }
    return this.failed
  }

  /**
   * Set one shortcut. `accel` null restores the default, '' removes the shortcut. Any other
   * command using the same keys loses them, so there are never two actions on one shortcut.
   */
  set(id: CommandId, accel: string | null): { ok: boolean; error?: string; cleared?: CommandId } {
    const def = command(id)
    const next = accel ?? def.accel ?? ''
    if (next && !validForScope(next, def.scope)) {
      return { ok: false, error: 'Shortcuts that work from any app need Ctrl, Alt or an F key.' }
    }
    const before = { ...this.overrides }
    let cleared: CommandId | undefined
    if (next) {
      const clash = COMMANDS.find((c) => c.id !== id && this.bindings[c.id] === next)
      if (clash) {
        this.overrides[clash.id] = ''
        cleared = clash.id
      }
    }
    if (accel === null) {
      delete this.overrides[id]
    } else {
      this.overrides[id] = accel
    }
    this.registerGlobals()
    if (def.scope === 'global' && next && this.failed.includes(id)) {
      this.overrides = before
      this.registerGlobals()
      return { ok: false, error: 'Another app is already using that shortcut.' }
    }
    this.save()
    return { ok: true, cleared }
  }

  resetAll(): void {
    this.overrides = {}
    this.registerGlobals()
    this.save()
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.writeFileSync(file(), JSON.stringify(this.overrides, null, 2))
    } catch (err) {
      console.warn('[keys] could not save', err)
    }
  }
}
