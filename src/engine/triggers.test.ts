import { describe, it, expect } from 'vitest'
import { parseTriggers, triggersFor, orderTriggers } from './triggers'

const mkCard = (text: string, extra: Record<string, unknown> = {}) =>
  ({
    id: `tg-${Math.abs(hash(text))}`,
    name: 'T',
    type: 'unit',
    domains: ['fury'],
    rarity: 'common',
    set: 'X',
    number: 1,
    text,
    energy: 1,
    power: {},
    might: 3,
    ...extra,
  }) as never
// tiny stable hash so each synthetic card gets a distinct id (parseTriggers caches by id)
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

describe('trigger parsing', () => {
  it('recognizes a self death trigger and its effect', () => {
    const abilities = parseTriggers(mkCard("When I'm defeated, draw a card."))
    const death = abilities.find((a) => a.event === 'death')
    expect(death).toBeTruthy()
    expect(death!.scope).toBe('self')
    expect(death!.effect.draw).toBe(1)
  })

  it('recognizes a global conquer trigger', () => {
    const abilities = parseTriggers(mkCard('When you conquer, channel 1.'))
    const conquer = abilities.find((a) => a.event === 'conquer')
    expect(conquer).toBeTruthy()
    expect(conquer!.scope).toBe('global')
    expect(conquer!.effect.channel).toBe(1)
  })

  it('recognizes a start-of-turn trigger', () => {
    const abilities = parseTriggers(mkCard('At the start of your turn, draw 1.'))
    expect(abilities.some((a) => a.event === 'startOfTurn' && a.effect.draw === 1)).toBe(true)
  })

  it('recognizes a global "when you play a spell" trigger', () => {
    const abilities = triggersFor(mkCard('When you play a spell, draw a card.'), 'play')
    expect(abilities.length).toBe(1)
    expect(abilities[0].scope).toBe('global')
    expect(abilities[0].effect.draw).toBe(1)
  })

  it('derives a death trigger from the [Deathknell] keyword', () => {
    const abilities = parseTriggers(
      mkCard('[Deathknell] Play a 1 :rb_might: Recruit unit token.'),
    )
    const death = abilities.find((a) => a.event === 'death')
    expect(death).toBeTruthy()
    expect(death!.effect.recruits).toBe(1)
  })

  it('flags an optional ("you may") trigger', () => {
    const abilities = parseTriggers(mkCard('When you conquer, you may draw a card.'))
    expect(abilities.find((a) => a.event === 'conquer')!.optional).toBe(true)
  })

  it('parses a +Might buff effect', () => {
    const abilities = parseTriggers(mkCard('When I attack, this unit gains +1 Might.'))
    expect(abilities.find((a) => a.event === 'attack')!.effect.buff).toBe(1)
  })
})

describe('trigger ordering (T10)', () => {
  it('orders simultaneous triggers turn-player first, then by seat', () => {
    const fired = [
      { player: 2, tag: 'c' },
      { player: 0, tag: 'a' },
      { player: 1, tag: 'b' },
    ]
    const ordered = orderTriggers(fired, 1, 3).map((f) => f.tag)
    // turn player = 1 → order should be seat 1, then 2, then 0.
    expect(ordered).toEqual(['b', 'c', 'a'])
  })

  it('keeps stable order within the same seat', () => {
    const fired = [
      { player: 0, tag: 'x' },
      { player: 0, tag: 'y' },
    ]
    expect(orderTriggers(fired, 0, 2).map((f) => f.tag)).toEqual(['x', 'y'])
  })
})
