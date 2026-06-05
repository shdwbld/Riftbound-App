import type { Card } from '../types/cards'
import { onPlayEffect, spellEffect, endOfTurnEffect, type ParsedEffect } from '../engine/effects'
import { parseTriggers } from '../engine/triggers'
import { keywordLabels } from '../engine/keywords'
import { actionDef } from './cardSpecVocab'
import { emptySpec, type CardSpec, type CardSpecRow, type SpecEffect, type SpecTarget, type SpecTargetScope, type SpecCondition } from './cardSpecs'

/** Engine TargetScope ('enemy'|'friendly'|'any'|null) → spec scope (null → 'any'). */
const mapScope = (s: 'enemy' | 'friendly' | 'any' | null): SpecTargetScope => s ?? 'any'

// Round-trip pre-fill: the engine already parses card.text into the same structure
// the card-spec grammar uses, so seed the editor from the parser and let the user
// only CORRECT it. The diff (parser = current engine behavior) vs the saved spec
// (intended) is the coverage signal; export feeds the handler-coverage analysis.

const op = (key: string) => actionDef(key)?.op

/** Map a parsed effect → SpecEffect[] (one row per non-empty ParsedEffect field). */
export function parsedEffectToSpecEffects(pe: ParsedEffect): SpecEffect[] {
  const out: SpecEffect[] = []
  const push = (key: string, e: Partial<SpecEffect> = {}) => out.push({ key, op: op(key), ...e })
  if (pe.draw) push('draw', { amount: pe.draw, sub: pe.drawPerBattlefield ? { perBattlefield: pe.drawPerBattlefield } : undefined })
  if (pe.discard) push('discard', { amount: pe.discard })
  if (pe.channel) push('channel', { amount: pe.channel })
  if (pe.channelExhausted) push('channelExhausted', { amount: pe.channelExhausted })
  if (pe.readyRunes) push('readyRunes', { amount: pe.readyRunes })
  if (pe.damage) push('damage', { amount: pe.damage, scope: mapScope(pe.targetScope), count: pe.targetCount })
  if (pe.kill) push('kill', { count: pe.kill, scope: mapScope(pe.targetScope), sub: pe.killMightMax != null ? { mightMax: pe.killMightMax } : undefined })
  if (pe.cullEachPlayer) push('cullEachPlayer')
  if (pe.strikeDown) push('strikeDown')
  if (pe.stun) push('stun', { amount: pe.stun, scope: mapScope(pe.targetScope), sub: pe.ifTargetStunned ? { ifStunned: pe.ifTargetStunned } : undefined })
  if (pe.buff || pe.buffSelf || pe.buffAll) push('buff', { amount: pe.buff || 1, duration: 'permanent', scope: pe.buffSelf ? 'self' : 'friendly', sub: pe.buffAll ? { all: pe.buffAll } : undefined })
  if (pe.tempMight) push('tempMight', { amount: pe.tempMight, duration: 'thisTurn', scope: mapScope(pe.targetScope) })
  if (pe.tempMightSelf) push('tempMight', { amount: pe.tempMightSelf, duration: 'thisTurn', scope: 'self' })
  if (pe.tempMightAll) push('tempMight', { amount: pe.tempMightAll, duration: 'thisTurn', scope: 'friendly', sub: { all: true } })
  if (pe.tempMightAllEnemy) push('tempMight', { amount: pe.tempMightAllEnemy, duration: 'thisTurn', scope: 'enemy', sub: { all: true } })
  if (pe.tempMightTag) push('tempMight', { amount: pe.tempMightTag.amount, duration: 'thisTurn', sub: { tag: pe.tempMightTag.tag } })
  if (pe.grantAssault || pe.grantAssaultHere) push('grantAssault', { amount: pe.grantAssault || pe.grantAssaultHere, sub: pe.grantAssaultHere ? { here: true } : undefined })
  if (pe.grantGanking) push('grantGanking')
  if (pe.bounce) push('bounce', { scope: pe.bounce })
  if (pe.moveToBase) push('recall', { scope: mapScope(pe.targetScope) })
  if (pe.moveUnit) push('moveUnit', { scope: mapScope(pe.targetScope) })
  if (pe.deathShield) push('deathShield')
  if (pe.readyUnits) push('ready', { amount: pe.readyUnits })
  if (pe.readyAllUnits) push('readyAll')
  if (pe.recruits) push('recruits', { amount: pe.recruits, sub: pe.recruitsHere ? { here: true } : undefined })
  if (pe.goldTokens) push('goldTokens', { amount: pe.goldTokens })
  if (pe.namedToken) push('namedToken', { sub: { ...pe.namedToken } })
  if (pe.score) push('score', { amount: pe.score })
  if (pe.gainXp) push('gainXp', { amount: pe.gainXp })
  if (pe.returnFromTrash) push('returnFromTrash', { sub: { ...pe.returnFromTrash } })
  if (pe.playUnitFromTrash) push('playUnitFromTrash', { sub: { ...pe.playUnitFromTrash } as Record<string, string | number | boolean> })
  if (pe.playSpellFromTrash) push('playSpellFromTrash')
  if (pe.revealPlayFromDeck) push('tutorFromDeck')
  if (pe.peekDraw) push('peekDraw', { sub: { n: pe.peekDraw.n, type: pe.peekDraw.type } })
  if (pe.peekToHand) push('peekToHand', { sub: { n: pe.peekToHand.n } })
  if (pe.peekBanishPlay) push('peekBanishPlay', { sub: { n: pe.peekBanishPlay.n, from: pe.peekBanishPlay.from } })
  if (pe.manual && out.length === 0) push('other', { note: 'parser flagged manual — describe behavior' })
  return out
}

function parsedToTarget(pe: ParsedEffect): SpecTarget | undefined {
  if (!pe.targetCount) return undefined
  return { scope: mapScope(pe.targetScope), count: pe.targetCount, zone: pe.battlefieldOnly ? 'battlefield' : 'anywhere' }
}
function parsedToConditions(pe: ParsedEffect): SpecCondition[] | undefined {
  if (!pe.condition) return undefined
  return [{ kind: pe.condition.kind, value: pe.condition.value, tag: pe.condition.tag }]
}
function hasEffect(pe: ParsedEffect): boolean {
  return parsedEffectToSpecEffects(pe).length > 0
}

/** Seed a CardSpec from the engine's parsers (the user then corrects it). */
export function prefillSpecFromCard(card: Card): CardSpec {
  const spec = emptySpec()
  spec.cardType = card.type
  spec.prefilled = true

  // Keywords (incl. parameterized N).
  for (const label of keywordLabels(card) ?? []) {
    const m = /\s*(\d+)\s*$/.exec(label)
    const keywordN = m ? parseInt(m[1], 10) : undefined
    const keyword = label.replace(/\s*\d+\s*$/, '').trim()
    spec.abilities.push({ kind: 'keyword', keyword, keywordN, rawText: label, fromParser: true })
  }

  // Rune: only produces.
  if (card.type === 'rune') {
    const produces = (card as { produces?: string[] }).produces
    if (produces) spec.produces = [...produces]
    return spec
  }

  // On-play / spell effect.
  const playPe = card.type === 'spell' ? spellEffect(card) : onPlayEffect(card)
  if (hasEffect(playPe)) {
    spec.abilities.push({
      kind: 'play',
      effects: parsedEffectToSpecEffects(playPe),
      target: parsedToTarget(playPe),
      conditions: parsedToConditions(playPe),
      fromParser: true,
    })
  }

  // Triggered abilities.
  for (const t of parseTriggers(card) ?? []) {
    if (!hasEffect(t.effect)) continue
    spec.abilities.push({
      kind: 'triggered',
      trigger: t.event,
      triggerScope: t.scope,
      optional: t.optional,
      effects: parsedEffectToSpecEffects(t.effect),
      target: parsedToTarget(t.effect),
      conditions: parsedToConditions(t.effect),
      fromParser: true,
    })
  }

  // End-of-turn effect.
  const eot = endOfTurnEffect(card)
  if (hasEffect(eot)) {
    spec.abilities.push({ kind: 'triggered', trigger: 'endOfTurn', effects: parsedEffectToSpecEffects(eot), fromParser: true })
  }

  return spec
}

/** A compact one-line summary of a spec for the table cell. */
export function summarizeSpec(spec: CardSpec | null): string {
  if (!spec || spec.abilities.length === 0) return ''
  if (spec.produces?.length) return `produces ${spec.produces.join('/')}`
  const a = spec.abilities[0]
  const head = a.kind === 'keyword' ? `[${a.keyword}${a.keywordN ? ' ' + a.keywordN : ''}]` : (a.trigger ? a.trigger : a.kind)
  const eff = (a.effects ?? []).map((e) => `${actionDef(e.key)?.label ?? e.key}${e.amount != null ? ' ' + e.amount : ''}`).slice(0, 2).join(', ')
  const extra = spec.abilities.length - 1
  return [head, eff].filter(Boolean).join(' → ') + (extra > 0 ? ` (+${extra})` : '')
}

/** Export all specs as machine-readable JSON for the handler-coverage analysis. */
export function exportAllSpecs(rows: Map<string, CardSpecRow>, cards: Card[]): string {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const out = [...rows.values()].map((r) => ({
    cardId: r.card_id,
    name: r.name,
    type: byId.get(r.card_id)?.type ?? r.spec?.cardType ?? null,
    status: r.status,
    produces: r.spec?.produces,
    abilities: (r.spec?.abilities ?? []).map((a) => ({
      kind: a.kind,
      keyword: a.keyword,
      trigger: a.trigger,
      optional: a.optional,
      conditions: a.conditions,
      effects: (a.effects ?? []).map((e) => ({ key: e.key, parsedKey: actionDef(e.key)?.parsedKey, op: e.op ?? actionDef(e.key)?.op, amount: e.amount, scope: e.scope, duration: e.duration })),
      status: a.status,
      fromParser: a.fromParser,
    })),
    comments: r.spec?.comments,
  }))
  return JSON.stringify(out, null, 2)
}
