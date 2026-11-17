import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ExportRequest,
  ExportResult,
  ProbeResult,
  ProgressEvent,
  RecordOptions,
  RecordResult,
  RecordState,
  SourcesResult,
  WarmupResult
} from '../shared/types'
import type { CommandId, KeyState, UiState } from '../shared/commands'

export interface AppInfo {
  platform: NodeJS.Platform
  version: string
  keys: KeyState
}

function listen<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (_: unknown, data: T): void => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  pickFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:open'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  probe: (filePath: string): Promise<ProbeResult> => ipcRenderer.invoke('video:probe', filePath),
  thumbnails: (filePath: string, durationSec: number): Promise<string[]> =>
    ipcRenderer.invoke('video:thumbs', filePath, durationSec),
  previewProxy: (filePath: string, durationSec: number): Promise<string | null> =>
    ipcRenderer.invoke('video:proxy', filePath, durationSec),
  startExport: (req: ExportRequest): Promise<ExportResult> =>
    ipcRenderer.invoke('export:start', req),
  cancelExport: (): Promise<boolean> => ipcRenderer.invoke('export:cancel'),
  copyToClipboard: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('file:copy', filePath),
  reveal: (filePath: string): void => ipcRenderer.send('file:reveal', filePath),
  startDrag: (filePath: string): void => ipcRenderer.send('file:drag', filePath),
  onProgress: (cb: (e: ProgressEvent) => void): (() => void) => listen('progress', cb),

  // Recording
  listSources: (): Promise<SourcesResult> => ipcRenderer.invoke('rec:sources'),
  startRecording: (sourceId: string, opts: RecordOptions): Promise<boolean> =>
    ipcRenderer.invoke('rec:start', sourceId, opts),
  stopRecording: (): void => ipcRenderer.send('rec:stop'),
  cancelRecording: (): void => ipcRenderer.send('rec:cancel'),
  pushAudio: (chunk: Uint8Array): void => ipcRenderer.send('rec:audio', chunk),
  onRecordState: (cb: (s: RecordState) => void): (() => void) => listen('rec:state', cb),
  onRecordDone: (cb: (r: RecordResult) => void): (() => void) => listen('rec:done', cb),
  onAudioCapture: (cb: (on: boolean) => void): (() => void) => listen('rec:audio-capture', cb),

  // Menu / tray / taskbar / command line
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  showWindow: (): void => ipcRenderer.send('app:show'),
  warmup: (): Promise<WarmupResult> => ipcRenderer.invoke('app:warmup'),
  sendUiState: (s: UiState): void => ipcRenderer.send('ui:state', s),
  setKey: (
    id: CommandId,
    accel: string | null
  ): Promise<{ ok: boolean; error?: string; cleared?: CommandId; keys: KeyState }> =>
    ipcRenderer.invoke('keys:set', id, accel),
  resetKeys: (): Promise<KeyState> => ipcRenderer.invoke('keys:reset'),
  setCapturingKeys: (on: boolean): void => ipcRenderer.send('keys:capturing', on),
  onKeysChanged: (cb: (k: KeyState) => void): (() => void) => listen('keys:changed', cb),
  onCommand: (cb: (c: CommandId) => void): (() => void) => listen('app:command', cb),
  onOpenPath: (cb: (p: string) => void): (() => void) => listen('app:open-path', cb)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
