import { createResource, For, Show, type JSX } from 'solid-js'
import AppWindow from 'lucide-solid/icons/app-window'
import Monitor from 'lucide-solid/icons/monitor'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import Dialog from './Dialog'
import Toggle from './Toggle'
import type { CaptureSource } from '../../../shared/types'

export default function RecordPicker(props: {
  audio: boolean
  fps: number
  stopKey: string | null
  onAudio: (on: boolean) => void
  onClose: () => void
  onPicked: () => void
}): JSX.Element {
  const [list, { refetch }] = createResource(() => window.api.listSources())

  const pick = async (s: CaptureSource): Promise<void> => {
    const ok = await window.api.startRecording(s.id, { audio: props.audio, fps: props.fps })
    if (ok) {
      props.onPicked()
    }
  }

  const group = (kind: 'screen' | 'window'): CaptureSource[] =>
    list()?.sources.filter((s) => s.kind === kind) ?? []

  return (
    <Dialog
      title="Record Screen"
      onClose={props.onClose}
      width="820px"
      footer={
        <>
          <Toggle checked={props.audio} onChange={props.onAudio} label="Record computer audio">
            Computer audio
          </Toggle>
          <span class="text-fg-3 text-[12px] ml-2 mono">{props.fps} fps</span>
          <span class="ml-auto text-[12px] text-fg-2">
            Starts 5 s after you choose · stops at 5:00
            <Show when={props.stopKey}>
              {' '}
              · stop with <kbd>{props.stopKey}</kbd>
            </Show>
          </span>
        </>
      }
    >
      <div class="p-4">
        <Show
          when={!list.loading}
          fallback={<div class="py-16 text-center text-fg-2">Looking for screens and windows…</div>}
        >
          <Show
            when={list()?.ok}
            fallback={
              <div class="py-12 text-center text-bad" role="alert">
                {list()?.reason}
              </div>
            }
          >
            <Section title="Screens" icon="screen" items={group('screen')} onPick={pick} first />
            <Show when={group('window').length}>
              <Section title="Windows" icon="window" items={group('window')} onPick={pick} />
            </Show>
            <div class="flex justify-end">
              <button class="btn btn-ghost text-fg-2!" onClick={() => refetch()}>
                <RefreshCw size={13} /> Refresh list
              </button>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}

function Section(props: {
  title: string
  icon: 'screen' | 'window'
  items: CaptureSource[]
  onPick: (s: CaptureSource) => void
  first?: boolean
}): JSX.Element {
  return (
    <section class="mb-4" aria-label={props.title}>
      <h3 class="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-fg-2">
        {props.icon === 'screen' ? <Monitor size={13} /> : <AppWindow size={13} />}
        {props.title}
        <span class="text-fg-3 font-normal">{props.items.length}</span>
      </h3>
      <div class="grid grid-cols-4 gap-2.5">
        <For each={props.items}>
          {(s, i) => (
            <button
              onClick={() => props.onPick(s)}
              data-autofocus={props.first && i() === 0 ? '' : undefined}
              class="group text-left rounded-[5px] border border-line bg-raised p-1.5 hover:border-accent hover:bg-hover focus-visible:border-accent"
              title={`Record ${s.name}`}
            >
              <div class="aspect-video rounded-[3px] bg-base overflow-hidden flex items-center justify-center">
                <Show
                  when={s.thumbnail}
                  fallback={<span class="text-[11px] text-fg-3">No preview</span>}
                >
                  <img src={s.thumbnail} alt="" class="w-full h-full object-contain" />
                </Show>
              </div>
              <div class="mt-1.5 px-0.5 text-[12px] truncate text-fg-2 group-hover:text-fg">
                {s.name}
              </div>
            </button>
          )}
        </For>
      </div>
    </section>
  )
}
