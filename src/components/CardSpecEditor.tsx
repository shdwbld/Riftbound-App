import { useState } from 'react'
import type { Card } from '../types/cards'
import { DOMAINS, DOMAIN_META } from '../types/cards'
import type { CardSpec, SpecAbility } from '../lib/cardSpecs'
import { emptySpec } from '../lib/cardSpecs'
import ComboInput from './ComboInput'

// Structured "intended use" builder for a card. Every field is a combobox (preset
// options + free type). Sections: Primary, repeatable Additional Actives /
// Passives, and a free-text comments box. Saves the whole structured object.

const TRIGGERS = ['play', 'attack', 'defend', 'conquer', 'hold', 'death', 'activated', 'passive', 'start-of-turn', 'end-of-turn', 'on-stun', 'on-buff', 'on-kill', 'when-you-recycle'] as const
const TARGETS = ['a friendly unit', 'an enemy unit', 'any unit', 'all units', 'a unit here', 'all friendly units', 'all enemy units', 'self', 'a battlefield', 'a rune', 'target player', 'none'] as const
const COSTS = ['none', 'Exhaust this', 'Recycle a rune', 'Energy', 'Power', 'Exhaust legend'] as const
const RUNES = [...DOMAINS.map((d) => DOMAIN_META[d].label), 'Wild'] as const
const EFFECTS = ['Damage N', 'Damage = Might', 'Buff (+1 Might)', '[Stun]', 'Kill', 'Draw N', 'Channel N', 'Recall to base', 'Bounce to hand', 'Move to a battlefield', 'Heal N', 'Play a token', 'Ready', 'Exhaust', 'Gain N XP', 'Score N point'] as const
const CONDITIONS = ['none', 'if [Mighty]', 'if you control a <Tribe>', 'if Level N', 'if you have N+ cards in hand', 'if a unit died this turn', 'if at a battlefield'] as const

const SECTION = 'rounded-lg border border-white/10 bg-white/5 p-3 space-y-2'
const LABEL = 'text-[10px] font-semibold uppercase tracking-wide text-white/40'

function Field({ label, value, onChange, options, placeholder }: { label: string; value?: string; onChange: (v: string) => void; options: readonly string[]; placeholder?: string }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <ComboInput value={value ?? ''} onChange={onChange} options={options} placeholder={placeholder} />
    </label>
  )
}

export default function CardSpecEditor({
  card,
  initial,
  onSave,
  onClose,
}: {
  card: Card
  initial: CardSpec | null
  onSave: (spec: CardSpec) => Promise<void> | void
  onClose: () => void
}) {
  const [spec, setSpec] = useState<CardSpec>(initial ?? emptySpec())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const setPrimary = (patch: Partial<CardSpec['primary']>) => setSpec((s) => ({ ...s, primary: { ...s.primary, ...patch } }))
  const setRow = (key: 'actives' | 'passives', i: number, patch: Partial<SpecAbility>) =>
    setSpec((s) => ({ ...s, [key]: s[key].map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const addRow = (key: 'actives' | 'passives') => setSpec((s) => ({ ...s, [key]: [...s[key], {}] }))
  const delRow = (key: 'actives' | 'passives', i: number) => setSpec((s) => ({ ...s, [key]: s[key].filter((_, j) => j !== i) }))

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      await onSave(spec)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-amber-500/30 bg-[#10131c] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 p-4">
          <span className="text-base font-bold text-amber-100">Intended use — {card.name.replace(/\s*\([^)]*\)\s*$/, '')}</span>
          <button onClick={onClose} className="ml-auto rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20">✕</button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {/* Primary */}
          <div className={SECTION}>
            <div className="text-sm font-semibold text-white/80">Primary ability</div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Trigger" value={spec.primary.trigger} onChange={(v) => setPrimary({ trigger: v })} options={TRIGGERS} placeholder="play / attack / activated…" />
              <Field label="Targets" value={spec.primary.target} onChange={(v) => setPrimary({ target: v })} options={TARGETS} />
              <Field label="Cost" value={spec.primary.cost} onChange={(v) => setPrimary({ cost: v })} options={COSTS} placeholder="Exhaust / Recycle…" />
              <Field label="Which rune (if any)" value={spec.primary.rune} onChange={(v) => setPrimary({ rune: v })} options={RUNES} />
              <Field label="Additional cost" value={spec.primary.additionalCost} onChange={(v) => setPrimary({ additionalCost: v })} options={['none', 'discard a unit', 'kill a unit', 'spend a buff']} />
              <Field label="Effect" value={spec.primary.effect} onChange={(v) => setPrimary({ effect: v })} options={EFFECTS} placeholder="Damage 5 based on Might" />
              <Field label="Secondary effects" value={spec.primary.secondary} onChange={(v) => setPrimary({ secondary: v })} options={EFFECTS} />
              <Field label="Conditional requirements" value={spec.primary.conditions} onChange={(v) => setPrimary({ conditions: v })} options={CONDITIONS} />
            </div>
          </div>

          {/* Additional Actives */}
          <div className={SECTION}>
            <div className="flex items-center">
              <span className="text-sm font-semibold text-white/80">Additional Actives</span>
              <button onClick={() => addRow('actives')} className="ml-auto rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20">＋ Add</button>
            </div>
            {spec.actives.map((r, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded bg-black/20 p-2">
                <Field label="Target" value={r.target} onChange={(v) => setRow('actives', i, { target: v })} options={TARGETS} />
                <Field label="Cost" value={r.cost} onChange={(v) => setRow('actives', i, { cost: v })} options={COSTS} />
                <Field label="Effect" value={r.effect} onChange={(v) => setRow('actives', i, { effect: v })} options={EFFECTS} />
                <Field label="Secondary effects" value={r.secondary} onChange={(v) => setRow('actives', i, { secondary: v })} options={EFFECTS} />
                <button onClick={() => delRow('actives', i)} className="col-span-2 justify-self-end text-xs text-rose-300 hover:text-rose-200">remove</button>
              </div>
            ))}
            {spec.actives.length === 0 && <div className="text-xs text-white/30">none</div>}
          </div>

          {/* Additional Passives */}
          <div className={SECTION}>
            <div className="flex items-center">
              <span className="text-sm font-semibold text-white/80">Additional Passives</span>
              <button onClick={() => addRow('passives')} className="ml-auto rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20">＋ Add</button>
            </div>
            {spec.passives.map((r, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded bg-black/20 p-2">
                <Field label="Target" value={r.target} onChange={(v) => setRow('passives', i, { target: v })} options={TARGETS} />
                <Field label="Conditions" value={r.conditions} onChange={(v) => setRow('passives', i, { conditions: v })} options={CONDITIONS} />
                <Field label="Effects" value={r.effect} onChange={(v) => setRow('passives', i, { effect: v })} options={EFFECTS} />
                <Field label="Secondary effects" value={r.secondary} onChange={(v) => setRow('passives', i, { secondary: v })} options={EFFECTS} />
                <button onClick={() => delRow('passives', i)} className="col-span-2 justify-self-end text-xs text-rose-300 hover:text-rose-200">remove</button>
              </div>
            ))}
            {spec.passives.length === 0 && <div className="text-xs text-white/30">none</div>}
          </div>

          {/* Comments */}
          <div className={SECTION}>
            <span className={LABEL}>Comments — manually enter intended usage / notes</span>
            <textarea
              value={spec.comments}
              onChange={(e) => setSpec((s) => ({ ...s, comments: e.target.value }))}
              rows={3}
              placeholder="Anything the structured fields don't capture…"
              className="w-full resize-y rounded bg-black/30 px-2 py-1 text-sm outline-none placeholder:text-white/25"
            />
          </div>

          {err && <div className="rounded bg-rose-500/15 px-3 py-2 text-xs text-rose-200">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 p-4">
          <button onClick={onClose} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20">Cancel</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-amber-500/80 px-4 py-2 text-sm font-bold text-black hover:bg-amber-400 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
