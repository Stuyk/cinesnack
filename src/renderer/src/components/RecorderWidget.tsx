import { createSignal, Match, onCleanup, onMount, Show, Switch, type JSX } from 'solid-js'
import { initKeys, keyOf } from '../keys'
import type { RecordState } from '../../../shared/types'

const mmss = (sec: number): string => {
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Small always-on-top bar. Visible during the countdown; once recording starts the main process
 * moves it outside the captured area or hides it, so it never shows up in the video.
 */
export default function RecorderWidget(): JSX.Element {
  const [state, setState] = createSignal<RecordState>({
    phase: 'countdown',
    countdown: 5,
    elapsedSec: 0,
    maxSec: 300,
    audio: true
  })
  // Either recording shortcut stops; show the first one that's bound.
  const stopKey = (): string => keyOf('record-focused') || keyOf('record')

  onMount(() => {
    onCleanup(window.api.onRecordState(setState))
    initKeys()
  })

  const progress = (): number => Math.min(1, state().elapsedSec / state().maxSec)

  return (
    <div
      class="relative h-full w-full flex items-center gap-3 pl-2 pr-2 bg-panel border border-line-strong"
      style={{ '-webkit-app-region': 'drag' }}
      role="status"
      aria-live="polite"
    >
      <Switch>
        <Match when={state().phase === 'countdown'}>
          <div class="w-8 h-8 shrink-0 rounded-[5px] bg-primary flex items-center justify-center mono text-[18px] font-medium text-white">
            {state().countdown}
          </div>
          <div class="flex-1 min-w-0 leading-tight">
            <div class="text-[13px] font-semibold">Recording starts in {state().countdown}</div>
            <div class="text-[11px] text-fg-2 truncate">
              <Show when={stopKey()} fallback="Stop from the tray icon">
                Stop later with {stopKey()} or the tray icon
              </Show>
            </div>
          </div>
          <WidgetButton onClick={() => window.api.cancelRecording()}>Cancel</WidgetButton>
        </Match>
        <Match when={state().phase === 'recording'}>
          <div class="w-8 h-8 shrink-0 flex items-center justify-center">
            <div class="w-3 h-3 rounded-full bg-rec animate-pulse" />
          </div>
          <div class="flex-1 min-w-0 mono text-[14px]">
            {mmss(state().elapsedSec)}
            <span class="text-fg-3"> / {mmss(state().maxSec)}</span>
            <Show when={!state().audio}>
              <span class="text-fg-3 text-[11px]"> · no audio</span>
            </Show>
          </div>
          <Show when={stopKey()}>
            <kbd>{stopKey()}</kbd>
          </Show>
          <WidgetButton onClick={() => window.api.stopRecording()} primary>
            Stop
          </WidgetButton>
          <div
            class="absolute left-0 bottom-0 h-[2px] bg-rec"
            style={{ width: `${progress() * 100}%` }}
          />
        </Match>
        <Match when={true}>
          <div class="flex-1 px-2 text-fg-2">Saving recording…</div>
        </Match>
      </Switch>
    </div>
  )
}

function WidgetButton(props: {
  onClick: () => void
  primary?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      onClick={props.onClick}
      style={{ '-webkit-app-region': 'no-drag' }}
      class="btn shrink-0"
      classList={{ 'btn-primary': props.primary }}
    >
      {props.children}
    </button>
  )
}
