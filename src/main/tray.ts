import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { Bindings } from '../shared/commands'
import type { RecordState } from '../shared/types'

export type AppCommand = 'record' | 'record-focused' | 'open' | 'show' | 'stop' | 'folder' | 'quit'

const mmss = (sec: number): string => {
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Shared by the tray menu and the macOS dock menu. */
export function commandMenu(
  run: (c: AppCommand) => void,
  state: RecordState['phase'],
  includeQuit: boolean,
  bindings?: Bindings
): MenuItemConstructorOptions[] {
  const busy = state !== 'idle'
  // Labels only: the keys themselves are global shortcuts owned by the main process.
  const shown = (id: 'record' | 'record-focused'): Partial<MenuItemConstructorOptions> =>
    bindings?.[id] ? { accelerator: bindings[id], registerAccelerator: false } : {}
  const items: MenuItemConstructorOptions[] = []
  if (state === 'countdown' || state === 'recording') {
    items.push({
      label: state === 'countdown' ? 'Cancel Recording' : 'Stop Recording',
      ...shown('record-focused'),
      click: () => run('stop')
    })
  } else {
    items.push(
      {
        label: 'Record Focused Window',
        ...shown('record-focused'),
        enabled: !busy,
        click: () => run('record-focused')
      },
      {
        label: 'Record Screen or Window…',
        ...shown('record'),
        enabled: !busy,
        click: () => run('record')
      }
    )
  }
  items.push(
    { label: 'Open Video…', enabled: !busy, click: () => run('open') },
    { type: 'separator' },
    { label: 'Show CineSnack', click: () => run('show') },
    { label: 'Open Exports Folder', click: () => run('folder') }
  )
  if (includeQuit) {
    items.push({ type: 'separator' }, { label: 'Quit CineSnack', click: () => run('quit') })
  }
  return items
}

/** A red record dot with a white ring, drawn straight into a BGRA bitmap (no asset file). */
function recordingIcon(size: number): Electron.NativeImage {
  const scale = 2
  const px = size * scale
  const buf = Buffer.alloc(px * px * 4)
  const c = px / 2
  const outer = px * 0.46
  const ring = px * 0.36
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      const i = (y * px + x) * 4
      // 1px of antialiasing on each edge.
      const a = Math.max(0, Math.min(1, outer - d + 0.5))
      if (a <= 0) {
        continue
      }
      const red = d < ring - 0.5 ? 1 : d > ring + 0.5 ? 0 : ring + 0.5 - d
      buf[i] = Math.round(0x5a * red + 0xff * (1 - red)) // B
      buf[i + 1] = Math.round(0x5a * red + 0xff * (1 - red)) // G
      buf[i + 2] = 0xff // R
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: px, height: px, scaleFactor: scale })
}

export class AppTray {
  private tray: Tray
  private phase: RecordState['phase'] = 'idle'
  private idleIcon: Electron.NativeImage
  private recIcon: Electron.NativeImage

  constructor(
    iconPath: string,
    private run: (c: AppCommand) => void,
    private bindings?: Bindings
  ) {
    const size = process.platform === 'darwin' ? 18 : 24
    this.idleIcon = nativeImage.createFromPath(iconPath).resize({ width: size, height: size })
    this.recIcon = recordingIcon(size)
    this.tray = new Tray(this.idleIcon)
    this.tray.setToolTip('CineSnack')
    // Linux app indicators only open the menu; elsewhere left-click toggles the window.
    this.tray.on('click', () => this.run(this.phase === 'recording' ? 'stop' : 'show'))
    this.rebuild()
  }

  setBindings(b: Bindings): void {
    this.bindings = b
    this.rebuild()
  }

  update(s: RecordState): void {
    if (s.phase !== this.phase) {
      this.phase = s.phase
      this.tray.setImage(s.phase === 'recording' ? this.recIcon : this.idleIcon)
      this.rebuild()
    }
    const tip =
      s.phase === 'recording'
        ? `CineSnack · recording ${mmss(s.elapsedSec)} of ${mmss(s.maxSec)} · click to stop`
        : s.phase === 'countdown'
          ? `CineSnack · recording in ${s.countdown}`
          : 'CineSnack'
    this.tray.setToolTip(tip)
  }

  private rebuild(): void {
    this.tray.setContextMenu(
      Menu.buildFromTemplate(commandMenu(this.run, this.phase, true, this.bindings))
    )
    if (process.platform === 'darwin') {
      app.dock?.setMenu(Menu.buildFromTemplate(commandMenu(this.run, this.phase, false)))
    }
  }

  destroy(): void {
    this.tray.destroy()
  }
}
