import { describe, it, expect } from 'vitest'
import { normalizeSpec, derivedStatus, emptySpec, type CardSpec } from './cardSpecs'

describe('cardSpecs model', () => {
  it('normalizeSpec handles null + already-v2', () => {
    expect(normalizeSpec(null)).toEqual({ abilities: [], comments: '' })
    const v2: CardSpec = { abilities: [{ kind: 'play', effects: [{ key: 'draw', amount: 1 }] }], comments: 'x' }
    expect(normalizeSpec(v2).abilities).toHaveLength(1)
  })

  it('normalizeSpec upgrades the legacy {primary,actives,passives} shape', () => {
    const legacy = {
      primary: { trigger: 'play', effect: 'Draw 1' },
      actives: [{ cost: 'exhaust', effect: 'Buff a unit' }],
      passives: [{ effect: 'Other units here have +1' }],
      comments: 'legacy note',
    }
    const v = normalizeSpec(legacy)
    expect(v.abilities).toHaveLength(3)
    expect(v.abilities[0].kind).toBe('triggered') // primary had a trigger
    expect(v.abilities[0].effects?.[0].note).toContain('Draw 1')
    expect(v.abilities[1].kind).toBe('activated')
    expect(v.abilities[1].cost?.additional).toBe('exhaust')
    expect(v.abilities[2].kind).toBe('static')
    expect(v.comments).toBe('legacy note')
  })

  it('derivedStatus is the worst across abilities', () => {
    expect(derivedStatus(emptySpec())).toBe('untested')
    expect(derivedStatus({ abilities: [{ kind: 'play', status: 'works' }, { kind: 'play', status: 'broken' }], comments: '' })).toBe('broken')
    expect(derivedStatus({ abilities: [{ kind: 'play', status: 'works' }, { kind: 'play', status: 'works' }], comments: '' })).toBe('works')
    expect(derivedStatus({ abilities: [{ kind: 'play', status: 'works' }, { kind: 'play', status: 'untested' }], comments: '' })).toBe('untested')
  })
})
