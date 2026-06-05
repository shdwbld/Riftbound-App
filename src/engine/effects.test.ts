import { describe, it, expect } from 'vitest'
import { parseEffectText, needsTarget, hasUntargetedPart } from './effects'

const spell = (text: string) =>
  ({ id: 'x', name: 'X', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never

describe('effect DSL (Phase 2)', () => {
  it('parses "[Add] <resource>" rune-ramp (Seals / Energy Conduit)', () => {
    const fury = parseEffectText('[Add] :rb_rune_fury:.')
    expect(fury.addPower.fury).toBe(1)
    const en = parseEffectText('[Add] :rb_energy_2:.')
    expect(en.addEnergy).toBe(2)
  })

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

  it('does not read a token\'s "ready" adjective as a ready-units action (Trevor)', () => {
    // "play a ready 3 Might Sprite unit token" creates a ready token — it must
    // NOT also ready 3 of your existing units.
    const e = parseEffectText('Play a ready 3 :rb_might: Sprite unit token with [Temporary] here.')
    expect(e.readyUnits).toBe(0)
    expect(e.namedToken?.name).toBe('sprite')
    expect(e.namedToken?.exhausted).toBe(false) // it does enter ready
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
