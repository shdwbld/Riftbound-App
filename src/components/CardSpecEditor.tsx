import { useState } from 'react'
import type { Card } from '../types/cards'
import CardText from './CardText'
import {
  emptySpec,
  type CardSpec,
  type AbilitySpec,
  type SpecEffect,
  type SpecCost,
  type SpecTarget,
  type SpecCondition,
  type SpecStatus,
} from '../lib/cardSpecs'
import { prefillSpecFromCard } from '../lib/cardIntent'
import {
  ACTION_CATALOG,
  actionDef,
  KINDS,
  KEYWORDS,
  TRIGGER_OPTIONS,
  TRIGGER_SCOPES,
  CONDITION_KINDS,
  TARGET_SCOPES,
  TARGET_ZONES,
  DURATIONS,
  DOMAIN_OPTIONS,
  type ActionGroup,
} from '../lib/cardSpecVocab'

// v2 card-spec editor: the ability-block grammar. Each card = an ordered list of
// AbilitySpec, each with kind-driven fields (trigger / cost / effects[] / target /
// conditions / modal branches). "Pre-fill from parser" seeds it from the engine.

const SECTION = 'rounded-lg border border-white/10 bg-white/5 p-2.5 space-y-2'
const LABEL = 'text-[10px] font-semibold uppercase tracking-wide text-white/40'
const SEL = 'rounded bg-black/30 px-1.5 py-1 text-xs'
const NUM = 'w-14 rounded bg-black/30 px-1.5 py-1 text-xs'
const BTN = 'rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20'
const STATUS_OPTS: SpecStatus[] = ['untested', 'works', 'unsure', 'broken']
const GROUP_LABELS: Record<ActionGroup, string> = { unit: 'Unit', might: 'Might', player: 'Player', token: 'Tokens', zone: 'Zone / move', trash: 'Trash / deck' }

function EffectKeySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const groups = [...new Set(ACTION_CATALOG.map((a) => a.group))]
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={SEL}>
      {groups.map((g) => (
        <optgroup key={g} label={GROUP_LABELS[g]}>
          {ACTION_CATALOG.filter((a) => a.group === g).map((a) => (
            <option key={a.key} value={a.key}>{a.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function EffectRow({ eff, onChange, onRemove }: { eff: SpecEffect; onChange: (e: SpecEffect) => void; onRemove: () => void }) {
  const def = actionDef(eff.key)
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded bg-black/20 p-1.5">
      <EffectKeySelect value={eff.key} onChange={(key) => onChange({ ...eff, key, op: actionDef(key)?.op })} />
      {def?.takesAmount && (
        <input type="number" value={eff.amount ?? ''} placeholder="N" onChange={(e) => onChange({ ...eff, amount: e.target.value === '' ? undefined : Number(e.target.value) })} className={NUM} />
      )}
      {def?.takesTarget && (
        <select value={eff.scope ?? 'any'} onChange={(e) => onChange({ ...eff, scope: e.target.value as SpecEffect['scope'] })} className={SEL}>
          {TARGET_SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
      <select value={eff.duration ?? 'permanent'} onChange={(e) => onChange({ ...eff, duration: e.target.value as SpecEffect['duration'] })} className={SEL} title="duration">
        {DURATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <input value={eff.note ?? ''} placeholder="note / sub-fields" onChange={(e) => onChange({ ...eff, note: e.target.value })} className="min-w-0 flex-1 rounded bg-black/30 px-1.5 py-1 text-xs placeholder:text-white/25" />
      <button onClick={onRemove} className="text-xs text-rose-300 hover:text-rose-200" title="remove">✕</button>
    </div>
  )
}

function CostEditor({ cost, onChange }: { cost: SpecCost | undefined; onChange: (c: SpecCost) => void }) {
  const c = cost ?? {}
  const setPower = (d: string, n: number) => { const power = { ...(c.power ?? {}) }; if (n <= 0) delete power[d]; else power[d] = n; onChange({ ...c, power }) }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={LABEL}>Cost</span>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!c.exhaustSelf} onChange={(e) => onChange({ ...c, exhaustSelf: e.target.checked })} /> exhaust</label>
        <span className="text-xs text-white/50">⚡</span>
        <input type="number" value={c.energy ?? ''} placeholder="0" onChange={(e) => onChange({ ...c, energy: e.target.value === '' ? undefined : Number(e.target.value) })} className={NUM} title="energy" />
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!c.spendBuff} onChange={(e) => onChange({ ...c, spendBuff: e.target.checked })} /> spend buff</label>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!c.killThis} onChange={(e) => onChange({ ...c, killThis: e.target.checked })} /> kill this</label>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-white/40">power:</span>
        {DOMAIN_OPTIONS.map((d) => (
          <span key={d.v} className="flex items-center gap-0.5">
            <button className={BTN} onClick={() => setPower(d.v, (c.power?.[d.v] ?? 0) + 1)} title={d.label}>{d.label.slice(0, 2)}+</button>
            {(c.power?.[d.v] ?? 0) > 0 && <span className="text-xs">{c.power![d.v]}<button className="ml-0.5 text-rose-300" onClick={() => setPower(d.v, (c.power?.[d.v] ?? 0) - 1)}>−</button></span>}
          </span>
        ))}
      </div>
    </div>
  )
}

function TargetEditor({ target, onChange }: { target: SpecTarget | undefined; onChange: (t: SpecTarget) => void }) {
  const t = target ?? { scope: 'none', count: 0 }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={LABEL}>Target</span>
      <select value={t.scope} onChange={(e) => onChange({ ...t, scope: e.target.value as SpecTarget['scope'] })} className={SEL}>
        {TARGET_SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <input type="number" value={t.count} onChange={(e) => onChange({ ...t, count: Number(e.target.value) })} className={NUM} title="count (0=none, all=99)" />
      <select value={t.zone ?? 'anywhere'} onChange={(e) => onChange({ ...t, zone: e.target.value as SpecTarget['zone'] })} className={SEL}>
        {TARGET_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>
      <input value={t.filter ?? ''} placeholder="filter (tag/keyword)" onChange={(e) => onChange({ ...t, filter: e.target.value })} className="min-w-0 flex-1 rounded bg-black/30 px-1.5 py-1 text-xs placeholder:text-white/25" />
    </div>
  )
}

function ConditionRow({ cond, onChange, onRemove }: { cond: SpecCondition; onChange: (c: SpecCondition) => void; onRemove: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select value={cond.kind} onChange={(e) => onChange({ ...cond, kind: e.target.value })} className={SEL}>
        {CONDITION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input type="number" value={cond.value ?? ''} placeholder="N" onChange={(e) => onChange({ ...cond, value: e.target.value === '' ? undefined : Number(e.target.value) })} className={NUM} />
      <input value={cond.tag ?? ''} placeholder="tag" onChange={(e) => onChange({ ...cond, tag: e.target.value })} className="w-24 rounded bg-black/30 px-1.5 py-1 text-xs placeholder:text-white/25" />
      <button onClick={onRemove} className="text-xs text-rose-300 hover:text-rose-200">✕</button>
    </div>
  )
}

function AbilityEditor({ ab, onChange, onRemove }: { ab: AbilitySpec; onChange: (a: AbilitySpec) => void; onRemove: () => void }) {
  const setEffects = (effects: SpecEffect[]) => onChange({ ...ab, effects })
  return (
    <div className={SECTION}>
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={ab.kind} onChange={(e) => onChange({ ...ab, kind: e.target.value as AbilitySpec['kind'] })} className={SEL}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        {ab.fromParser && <span className="rounded bg-sky-500/20 px-1 text-[9px] text-sky-200">parser</span>}
        <select value={ab.status ?? 'untested'} onChange={(e) => onChange({ ...ab, status: e.target.value as SpecStatus })} className={`${SEL} ml-auto`}>
          {STATUS_OPTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={onRemove} className="text-xs text-rose-300 hover:text-rose-200" title="remove ability">🗑</button>
      </div>

      {ab.kind === 'keyword' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select value={ab.keyword ?? ''} onChange={(e) => onChange({ ...ab, keyword: e.target.value })} className={SEL}>
            <option value="">— keyword —</option>
            {KEYWORDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          {KEYWORDS.find((k) => k.key === ab.keyword)?.takesN && (
            <input type="number" value={ab.keywordN ?? ''} placeholder="N" onChange={(e) => onChange({ ...ab, keywordN: e.target.value === '' ? undefined : Number(e.target.value) })} className={NUM} />
          )}
          <span className="text-[10px] text-white/40">{KEYWORDS.find((k) => k.key === ab.keyword)?.reminder}</span>
        </div>
      )}

      {ab.kind === 'triggered' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={LABEL}>When</span>
          <select value={ab.trigger ?? ''} onChange={(e) => onChange({ ...ab, trigger: e.target.value })} className={SEL}>
            <option value="">— trigger —</option>
            {TRIGGER_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={ab.triggerScope ?? 'self'} onChange={(e) => onChange({ ...ab, triggerScope: e.target.value as 'self' | 'global' })} className={SEL}>
            {TRIGGER_SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!ab.optional} onChange={(e) => onChange({ ...ab, optional: e.target.checked })} /> you may</label>
        </div>
      )}

      {(ab.kind === 'activated' || ab.kind === 'play' || ab.kind === 'triggered') && (
        <CostEditor cost={ab.cost} onChange={(cost) => onChange({ ...ab, cost })} />
      )}

      {/* Effects list (or modal branches) */}
      {ab.kind === 'modal' ? (
        <div className="space-y-1">
          <div className="flex items-center"><span className={LABEL}>Choose one — branches</span>
            <button className={`${BTN} ml-auto`} onClick={() => onChange({ ...ab, branches: [...(ab.branches ?? []), { effects: [] }] })}>＋ branch</button>
          </div>
          {(ab.branches ?? []).map((br, bi) => (
            <div key={bi} className="rounded bg-black/20 p-1.5 space-y-1">
              <input value={br.label ?? ''} placeholder={`branch ${bi + 1} label`} onChange={(e) => { const branches = [...(ab.branches ?? [])]; branches[bi] = { ...br, label: e.target.value }; onChange({ ...ab, branches }) }} className="w-full rounded bg-black/30 px-1.5 py-1 text-xs placeholder:text-white/25" />
              {br.effects.map((eff, ei) => (
                <EffectRow key={ei} eff={eff} onChange={(ne) => { const branches = [...(ab.branches ?? [])]; const effs = [...br.effects]; effs[ei] = ne; branches[bi] = { ...br, effects: effs }; onChange({ ...ab, branches }) }} onRemove={() => { const branches = [...(ab.branches ?? [])]; branches[bi] = { ...br, effects: br.effects.filter((_, j) => j !== ei) }; onChange({ ...ab, branches }) }} />
              ))}
              <button className={BTN} onClick={() => { const branches = [...(ab.branches ?? [])]; branches[bi] = { ...br, effects: [...br.effects, { key: 'damage' }] }; onChange({ ...ab, branches }) }}>＋ effect</button>
            </div>
          ))}
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={ab.oncePer === 'turn'} onChange={(e) => onChange({ ...ab, oncePer: e.target.checked ? 'turn' : null })} /> once per turn</label>
        </div>
      ) : ab.kind !== 'keyword' && (
        <div className="space-y-1">
          <div className="flex items-center"><span className={LABEL}>Effects</span>
            <button className={`${BTN} ml-auto`} onClick={() => setEffects([...(ab.effects ?? []), { key: 'damage', op: actionDef('damage')?.op }])}>＋ effect</button>
          </div>
          {(ab.effects ?? []).map((eff, i) => (
            <EffectRow key={i} eff={eff} onChange={(ne) => setEffects((ab.effects ?? []).map((e, j) => (j === i ? ne : e)))} onRemove={() => setEffects((ab.effects ?? []).filter((_, j) => j !== i))} />
          ))}
          <TargetEditor target={ab.target} onChange={(target) => onChange({ ...ab, target })} />
          <div className="flex items-center"><span className={LABEL}>Conditions</span>
            <button className={`${BTN} ml-auto`} onClick={() => onChange({ ...ab, conditions: [...(ab.conditions ?? []), { kind: 'handAtMost' }] })}>＋ condition</button>
          </div>
          {(ab.conditions ?? []).map((cond, i) => (
            <ConditionRow key={i} cond={cond} onChange={(nc) => onChange({ ...ab, conditions: (ab.conditions ?? []).map((c, j) => (j === i ? nc : c)) })} onRemove={() => onChange({ ...ab, conditions: (ab.conditions ?? []).filter((_, j) => j !== i) })} />
          ))}
        </div>
      )}

      <input value={ab.rawText ?? ''} placeholder="printed wording / note (mirror the card)" onChange={(e) => onChange({ ...ab, rawText: e.target.value })} className="w-full rounded bg-black/30 px-1.5 py-1 text-xs placeholder:text-white/25" />
    </div>
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

  const setAbility = (i: number, a: AbilitySpec) => setSpec((s) => ({ ...s, abilities: s.abilities.map((x, j) => (j === i ? a : x)) }))
  const addAbility = () => setSpec((s) => ({ ...s, abilities: [...s.abilities, { kind: card.type === 'spell' ? 'play' : 'triggered', effects: [], status: 'untested' }] }))
  const removeAbility = (i: number) => setSpec((s) => ({ ...s, abilities: s.abilities.filter((_, j) => j !== i) }))
  const toggleProduces = (d: string) => setSpec((s) => { const set = new Set(s.produces ?? []); set.has(d) ? set.delete(d) : set.add(d); return { ...s, produces: [...set] } })

  const save = async () => {
    setBusy(true); setErr(null)
    try { await onSave({ ...spec, cardType: card.type }); onClose() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-amber-500/30 bg-[#10131c] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-white/10 p-3">
          <span className="text-base font-bold text-amber-100">Intended use — {card.name.replace(/\s*\([^)]*\)\s*$/, '')}</span>
          <span className="rounded bg-white/10 px-1.5 text-[10px] text-white/50">{card.type}</span>
          <button onClick={() => setSpec(prefillSpecFromCard(card))} className="ml-auto rounded bg-sky-500/30 px-2.5 py-1 text-xs font-semibold text-sky-100 hover:bg-sky-500/50" title="Seed from the engine's parser, then correct it">⚙ Pre-fill from parser</button>
          <button onClick={onClose} className="rounded bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20">✕</button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {/* Printed text reference */}
          {card.text && (
            <div className="rounded-lg bg-black/30 p-2 text-sm text-white/80">
              <div className={LABEL}>Printed text</div>
              <CardText text={card.text} />
            </div>
          )}

          {card.type === 'rune' ? (
            <div className={SECTION}>
              <div className={LABEL}>Produces</div>
              <div className="flex flex-wrap gap-1">
                {DOMAIN_OPTIONS.map((d) => (
                  <button key={d.v} onClick={() => toggleProduces(d.v)} className={`rounded px-2 py-1 text-xs font-semibold ${(spec.produces ?? []).includes(d.v) ? 'bg-amber-500/40 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}>{d.label}</button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {spec.abilities.map((ab, i) => (
                <AbilityEditor key={i} ab={ab} onChange={(a) => setAbility(i, a)} onRemove={() => removeAbility(i)} />
              ))}
              <button onClick={addAbility} className="w-full rounded-lg border border-dashed border-white/20 py-2 text-sm text-white/60 hover:border-white/40 hover:text-white">＋ Add ability</button>
            </>
          )}

          <div className={SECTION}>
            <div className={LABEL}>Comments</div>
            <textarea value={spec.comments} onChange={(e) => setSpec((s) => ({ ...s, comments: e.target.value }))} rows={2} placeholder="anything the structured fields don't capture…" className="w-full resize-y rounded bg-black/30 px-2 py-1 text-sm outline-none placeholder:text-white/25" />
          </div>

          {err && <div className="rounded bg-rose-500/15 px-3 py-2 text-xs text-rose-200">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 p-3">
          <button onClick={onClose} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20">Cancel</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-amber-500/80 px-4 py-2 text-sm font-bold text-black hover:bg-amber-400 disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
