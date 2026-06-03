import { describe, it, expect } from 'vitest'
import { parseEffectText, needsTarget, hasUntargetedPart } from './effects'

const spell = (text: string) =>
  ({ id: 'x', name: 'X', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never

describe('effect DSL (Phase 2)', () => {
  it('targeted damage at a battlefield is enemy-scoped', () => {
    const e = parseEffectText('Deal 3 to a unit at a battlefield.')
    expect(e.damage).toBe(3)
    expect(e.targetCount).toBe(1)
    expect(e.battlefieldOnly).toBe(true)
    expect(e.targetScope).toBe('enemy')
  })

  it('parses an outright kill', () => {
    expect(parseEffectText('Kill a unit at a battlefield.').kill).toBe(1)
  })

  it('parses a signed Might-this-turn to a target', () => {
    const e = parseEffectText('Give a unit -1 :rb_might: this turn, to a minimum of 1 :rb_might:.')
    expect(e.tempMight).toBe(-1)
    expect(e.targetCount).toBe(1)
  })

  it('parses a self Might-this-turn (no target)', () => {
    const e = parseEffectText('Give me +1 :rb_might: this turn.')
    expect(e.tempMightSelf).toBe(1)
    expect(e.targetCount).toBe(0)
  })

  it('parses a multi-target count', () => {
    const e = parseEffectText('Deal 6 to each of up to two units.')
    expect(e.damage).toBe(6)
    expect(e.targetCount).toBe(2)
  })

  it('parses conditional draw-on-kill without double-counting the draw', () => {
    const e = parseEffectText('Deal 3 to a unit. If this kills it, draw 1.')
    expect(e.damage).toBe(3)
    expect(e.drawOnKill).toBe(1)
    expect(e.draw).toBe(0) // the draw is conditional, not unconditional
  })

  it('a damage+draw spell has both a targeted and an untargeted part', () => {
    const e = parseEffectText('Deal 4 to a unit at a battlefield. Draw 1.')
    expect(e.damage).toBe(4)
    expect(e.draw).toBe(1)
    expect(hasUntargetedPart(e)).toBe(true)
  })

  it('parses "ready a friendly unit" but not "enters ready"', () => {
    expect(parseEffectText('Ready a friendly unit.').readyUnits).toBe(1)
    expect(parseEffectText('Ready up to two units.').readyUnits).toBe(2)
    expect(parseEffectText('The next unit you play this turn enters ready.').readyUnits).toBe(0)
  })

  it('parses "play a Gold gear token"', () => {
    const e = parseEffectText('When I move, play a Gold gear token exhausted.')
    expect(e.goldTokens).toBe(1)
    expect(hasUntargetedPart(e)).toBe(true)
  })

  it('needsTarget: true for damage spells, false for draw-only', () => {
    expect(needsTarget(spell('Deal 2 to a unit.'))).toBe(true)
    expect(needsTarget(spell('Draw 2.'))).toBe(false)
  })
})
