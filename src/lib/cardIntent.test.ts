import { describe, it, expect } from 'vitest'
import { parseEffectText } from '../engine/effects'
import { parsedEffectToSpecEffects, prefillSpecFromCard, summarizeSpec } from './cardIntent'
import { CARDS } from '../data/cards'

describe('cardIntent', () => {
  it('parsedEffectToSpecEffects maps parser output to typed effect rows + op', () => {
    const pe = parseEffectText('Deal 3 to a unit. Draw 1.')
    const effs = parsedEffectToSpecEffects(pe)
    const byKey = Object.fromEntries(effs.map((e) => [e.key, e]))
    expect(byKey.damage?.amount).toBe(3)
    expect(byKey.draw?.amount).toBe(1)
    // damage maps to an executable override op.
    expect(byKey.damage?.op).toBe('damage')
  })

  it('tempMight maps to thisTurn duration (vs permanent buff)', () => {
    const t = parsedEffectToSpecEffects(parseEffectText('Give a unit +2 Might this turn.'))
    expect(t.find((e) => e.key === 'tempMight')?.duration).toBe('thisTurn')
    const b = parsedEffectToSpecEffects(parseEffectText('Buff a friendly unit.'))
    expect(b.find((e) => e.key === 'buff')?.duration).toBe('permanent')
  })

  it('prefillSpecFromCard fills produces for a rune and never throws on any card', () => {
    const rune = CARDS.find((c) => c.type === 'rune')!
    const rspec = prefillSpecFromCard(rune)
    expect(rspec.prefilled).toBe(true)
    expect((rspec.produces ?? []).length).toBeGreaterThan(0)
    // smoke: prefilling a sample across types doesn't throw
    for (const t of ['unit', 'spell', 'gear', 'battlefield', 'legend'] as const) {
      const c = CARDS.find((x) => x.type === t)
      if (c) expect(Array.isArray(prefillSpecFromCard(c).abilities)).toBe(true)
    }
  })

  it('prefill includes activated abilities (<cost>: <effect>)', () => {
    const ballista = CARDS.find((c) => c.name.startsWith('Iron Ballista'))
    if (!ballista) return
    const spec = prefillSpecFromCard(ballista)
    const act = spec.abilities.find((a) => a.kind === 'activated')
    expect(act).toBeTruthy()
    expect(act?.cost?.exhaustSelf).toBe(true)
    expect((act?.effects ?? []).some((e) => e.key === 'damage')).toBe(true)
  })

  it('summarizeSpec produces a short non-crashing summary', () => {
    expect(summarizeSpec(null)).toBe('')
    expect(summarizeSpec({ abilities: [{ kind: 'play', effects: [{ key: 'draw', amount: 2 }] }], comments: '' })).toMatch(/Draw/i)
  })
})
