import { type Deck, emptyDeck } from '../types/deck'

// ---------------------------------------------------------------------------
// Local deck storage (localStorage). Phase 5 swaps/augments this with Supabase
// sync behind the same interface.
// ---------------------------------------------------------------------------

const KEY = 'riftbound.decks.v1'

function readAll(): Record<string, Deck> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(decks: Record<string, Deck>) {
  localStorage.setItem(KEY, JSON.stringify(decks))
}

/** Time-ordered id without Date/Math.random reliance in the hot path. */
function newId(): string {
  return 'deck_' + Date.now().toString(36) + '_' + (counter++).toString(36)
}
let counter = 0

export function listDecks(): Deck[] {
  return Object.values(readAll()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getDeck(id: string): Deck | undefined {
  return readAll()[id]
}

export function createDeck(name = 'New Deck'): Deck {
  const deck = emptyDeck(newId(), name)
  deck.updatedAt = Date.now()
  const all = readAll()
  all[deck.id] = deck
  writeAll(all)
  return deck
}

export function saveDeck(deck: Deck): Deck {
  const next = { ...deck, updatedAt: Date.now() }
  const all = readAll()
  all[next.id] = next
  writeAll(all)
  return next
}

export function deleteDeck(id: string) {
  const all = readAll()
  delete all[id]
  writeAll(all)
}

// --- Import / export -------------------------------------------------------
//
// A human-readable, round-trippable text format:
//
//   Name: Aggro Jinx
//   Legend: ogn-247-298
//   # Main
//   3 ogn-010-298
//   2 ogn-011-298
//   # Runes
//   8 ogn-R01
//   # Battlefields
//   ogn-B01

export function exportDeck(deck: Deck): string {
  const lines: string[] = []
  lines.push(`Name: ${deck.name}`)
  if (deck.legendId) lines.push(`Legend: ${deck.legendId}`)
  lines.push('# Main')
  for (const [id, n] of Object.entries(deck.main)) lines.push(`${n} ${id}`)
  lines.push('# Runes')
  for (const [id, n] of Object.entries(deck.runes)) lines.push(`${n} ${id}`)
  lines.push('# Battlefields')
  for (const id of deck.battlefields) lines.push(id)
  return lines.join('\n')
}

export function parseDeck(text: string, id: string): Deck {
  const deck = emptyDeck(id, 'Imported Deck')
  let section: 'main' | 'runes' | 'battlefields' | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.toLowerCase().startsWith('name:')) {
      deck.name = line.slice(5).trim() || deck.name
      continue
    }
    if (line.toLowerCase().startsWith('legend:')) {
      deck.legendId = line.slice(7).trim() || null
      continue
    }
    if (line.startsWith('#')) {
      const s = line.slice(1).trim().toLowerCase()
      section = s.startsWith('main')
        ? 'main'
        : s.startsWith('rune')
          ? 'runes'
          : s.startsWith('battle')
            ? 'battlefields'
            : null
      continue
    }
    const m = line.match(/^(\d+)\s+(.+)$/)
    if (section === 'battlefields') {
      deck.battlefields.push(m ? m[2].trim() : line)
    } else if (section === 'main' || section === 'runes') {
      const count = m ? parseInt(m[1], 10) : 1
      const cardId = m ? m[2].trim() : line
      deck[section][cardId] = (deck[section][cardId] ?? 0) + count
    }
  }
  deck.updatedAt = Date.now()
  return deck
}

export function importDeck(text: string): Deck {
  const deck = parseDeck(text, newId())
  return saveDeck(deck)
}
