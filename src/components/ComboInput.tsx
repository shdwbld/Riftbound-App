import { useId } from 'react'

// A tiny combobox: a text input backed by a <datalist> of preset options, but
// fully free-typeable when the value isn't in the list. Zero dependencies.

export default function ComboInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: readonly string[]
  placeholder?: string
}) {
  const listId = useId()
  return (
    <>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded bg-black/30 px-2 py-1 text-sm outline-none placeholder:text-white/25"
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  )
}
