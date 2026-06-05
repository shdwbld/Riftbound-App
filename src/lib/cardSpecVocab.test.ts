import { describe, it, expect } from 'vitest'
import { ACTION_CATALOG, KEYWORDS, TRIGGER_OPTIONS, actionDef } from './cardSpecVocab'
import { TRIGGER_EVENTS } from '../engine/triggers'

describe('cardSpecVocab', () => {
  it('ACTION_CATALOG keys are unique', () => {
    const keys = ACTION_CATALOG.map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers core effects with both a parser key and an executable op where expected', () => {
    const byKey = Object.fromEntries(ACTION_CATALOG.map((a) => [a.key, a]))
    // damage / buff / tempMight / draw map to BOTH a ParsedEffect key and an override op.
    for (const k of ['damage', 'buff', 'tempMight', 'draw', 'channel']) {
      expect(byKey[k]?.parsedKey).toBeTruthy()
      expect(byKey[k]?.op).toBeTruthy()
    }
    // discard/zone interactions exist (the override-only actions the parser doesn't model).
    for (const k of ['recall', 'moveUnit', 'recycleRune', 'mill', 'returnFromTrash', 'tutorFromDeck', 'marker', 'setController']) {
      expect(byKey[k]).toBeTruthy()
    }
  })

  it('TRIGGER_OPTIONS includes every engine TriggerEvent', () => {
    for (const e of TRIGGER_EVENTS) expect(TRIGGER_OPTIONS).toContain(e)
  })

  it('KEYWORDS flags the N-parameter keywords', () => {
    const byKey = Object.fromEntries(KEYWORDS.map((k) => [k.key, k]))
    for (const k of ['shield', 'assault', 'deflect', 'hunt', 'level']) expect(byKey[k]?.takesN).toBe(true)
    expect(byKey['tank']?.takesN).toBe(false)
    expect(byKey['shield']?.reminder).toMatch(/Might/i)
  })

  it('actionDef resolves by key', () => {
    expect(actionDef('damage')?.label).toMatch(/damage/i)
    expect(actionDef('nope')).toBeUndefined()
  })
})
