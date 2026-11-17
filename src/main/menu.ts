import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import {
  command,
  COMMANDS,
  type Bindings,
  type CommandGroup,
  type CommandId,
  type UiState
} from '../shared/commands'
import type { RecordState } from '../shared/types'

const SITE = 'https://github.com/stuyk/cinesnack'

export interface MenuHooks {
  /** Renderer-side command (opens the window first when needed). */
  send: (id: CommandId) => void
  stopRecording: () => void
  openExportsFolder: () => void
  quit: () => void
}

/** Native application menu. Rebuilt whenever the renderer reports new state. */
export function buildAppMenu(
  ui: UiState,
  rec: RecordState['phase'],
  hooks: MenuHooks,
  bindings: Bindings
): Menu {
  const mac = process.platform === 'darwin'
  const busy = ui.exporting || rec !== 'idle'

  const enabled = (id: CommandId): boolean => {
    switch (id) {
      case 'open':
      case 'record':
      case 'record-focused':
        return !busy
      case 'export':
        return ui.hasFile && !busy
      case 'cancel':
        return ui.exporting
      case 'copy-output':
      case 'reveal-output':
        return ui.hasOutput && !ui.exporting
      case 'toggle-audio':
        return ui.audioAvailable && !ui.exporting
      case 'toggle-auto-export':
        return true
      case 'fps-30':
      case 'fps-60':
      case 'size-0':
      case 'size-1':
      case 'size-2':
        return !ui.exporting
      case 'shortcuts':
        return true
      default:
        return ui.hasFile && !ui.exporting
    }
  }

  const item = (
    id: CommandId,
    extra: Partial<MenuItemConstructorOptions> = {}
  ): MenuItemConstructorOptions => {
    const c = command(id)
    return {
      label: c.label,
      accelerator: bindings[id] || undefined,
      // Global shortcuts belong to the OS; page-handled keys must not fire while a dialog is open.
      registerAccelerator: !c.scope,
      enabled: enabled(id),
      click: () => hooks.send(id),
      ...extra
    }
  }
  const group = (g: CommandGroup): MenuItemConstructorOptions[] =>
    COMMANDS.filter((c) => c.group === g).map((c) => item(c.id))

  const stopLabel = rec === 'countdown' ? 'Cancel Recording' : 'Stop Recording'
  const recordItems: MenuItemConstructorOptions[] =
    rec === 'idle'
      ? [item('record'), item('record-focused')]
      : [
          {
            label: stopLabel,
            accelerator: bindings.record || bindings['record-focused'] || undefined,
            registerAccelerator: false,
            enabled: rec !== 'finishing',
            click: hooks.stopRecording
          }
        ]

  const template: MenuItemConstructorOptions[] = []
  if (mac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }
  template.push(
    {
      label: '&File',
      submenu: [
        item('open'),
        { type: 'separator' },
        ...recordItems,
        { type: 'separator' },
        item('export'),
        item('cancel'),
        { type: 'separator' },
        item('copy-output'),
        item('reveal-output'),
        { label: 'Open Exports Folder', click: hooks.openExportsFolder },
        { type: 'separator' },
        item('close-video'),
        ...(mac
          ? []
          : [
              { type: 'separator' } as MenuItemConstructorOptions,
              { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: hooks.quit }
            ])
      ]
    },
    { label: '&Playback', submenu: group('Playback') },
    { label: '&Trim', submenu: group('Trim') },
    {
      label: '&Output',
      submenu: [
        item('fps-30', { type: 'radio', checked: ui.fps === 30 }),
        item('fps-60', { type: 'radio', checked: ui.fps === 60 }),
        { type: 'separator' },
        item('toggle-audio', { type: 'checkbox', checked: ui.audio && ui.audioAvailable }),
        item('toggle-auto-export', { type: 'checkbox', checked: ui.autoExport }),
        { type: 'separator' },
        item('size-0', { type: 'radio', checked: ui.sizeIndex === 0 }),
        item('size-1', { type: 'radio', checked: ui.sizeIndex === 1 }),
        item('size-2', { type: 'radio', checked: ui.sizeIndex === 2 })
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'toggleDevTools' } as MenuItemConstructorOptions
            ])
      ]
    },
    {
      label: '&Help',
      submenu: [
        item('shortcuts'),
        { type: 'separator' },
        { label: 'CineSnack on GitHub', click: () => void shell.openExternal(SITE) },
        { label: 'Report a Problem', click: () => void shell.openExternal(`${SITE}/issues`) },
        ...(mac
          ? []
          : [
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'about' } as MenuItemConstructorOptions
            ])
      ]
    }
  )
  return Menu.buildFromTemplate(template)
}
