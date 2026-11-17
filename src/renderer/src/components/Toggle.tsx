import type { JSX } from 'solid-js'

/** On/off switch. Space or Enter toggles it, like a checkbox. */
export default function Toggle(props: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
  children?: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.children ? undefined : props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      class="inline-flex items-center gap-2 h-7 text-[13px] text-fg disabled:opacity-45"
    >
      <span
        class="relative w-[30px] h-[17px] rounded-full border transition-colors shrink-0"
        classList={{
          'bg-primary border-[#3a86ea]': props.checked,
          'bg-app border-line-strong': !props.checked
        }}
      >
        <span
          class="absolute top-[2px] w-[11px] h-[11px] rounded-full transition-[left]"
          classList={{
            'left-[15px] bg-white': props.checked,
            'left-[2px] bg-fg-3': !props.checked
          }}
        />
      </span>
      {props.children}
    </button>
  )
}
