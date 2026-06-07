import { type Deck, emptyDeck } from '../types/deck'
import { getCard, resolveCardRef } from '../data/cards'

// ---------------------------------------------------------------------------
// Local deck storage (localStorage). Phase 5 swaps/augments this with Supabase
// sync behind the same interface.
// ---------------------------------------------------------------------------

const KEY = 'riftbound.decks.v1'

function readAll(): Record<string, Deck> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    // Drop non-object entries and back-fill any missing piles so callers never
    // read undefined (corrupt/old/hand-edited localStorage shouldn't crash).
    const out: Record<string, Deck> = {}
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const d = v as Deck
      d.main = d.main ?? {}
      d.runes = d.runes ?? {}
      d.sideboard = d.sideboard ?? {}
      d.battlefields = Array.isArray(d.battlefields) ? d.battlefields : []
      out[id] = d
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(decks: Record<string, Deck>) {
  localStorage.setItem(KEY, JSON.stringify(decks))
}

/** Time-ordered id. The counter is seeded once (module load) from a random base so
 *  two decks created in the same millisecond after a reload don't collide. */
function newId(): string {
  return 'deck_' + Date.now().toString(36) + '_' + (counter++).toString(36)
}
let counter = Math.floor(Math.random() * 1_000_000)

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

/** Copy a template (e.g. a featured starter deck) into the local library as a
 *  fresh, independently-editable deck. */
export function cloneIntoLibrary(template: {
  name: string
  legendId: string | null
  championId?: string | null
  main?: Record<string, number>
  runes?: Record<string, number>
  battlefields?: string[]
  sideboard?: Record<string, number>
}): Deck {
  // Default every pile — a malformed share payload (missing a field) must not throw.
  const deck = emptyDeck(newId(), template.name)
  deck.legendId = template.legendId
  deck.championId = template.championId ?? null
  deck.main = { ...(template.main ?? {}) }
  deck.runes = { ...(template.runes ?? {}) }
  deck.battlefields = [...(template.battlefields ?? [])]
  deck.sideboard = { ...(template.sideboard ?? {}) }
  return saveDeck(deck)
}

/** Duplicate an existing library deck into a fresh, independent copy. */
export function duplicateDeck(id: string): Deck | undefined {
  const src = getDeck(id)
  if (!src) return undefined
  const deck = emptyDeck(newId(), `${src.name} (copy)`)
  deck.legendId = src.legendId
  deck.championId = src.championId ?? null
  deck.main = { ...src.main }
  deck.runes = { ...src.runes }
  deck.battlefields = [...src.battlefields]
  deck.sideboard = { ...src.sideboard }
  return saveDeck(deck)
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
  if (deck.championId) lines.push(`Champion: ${deck.championId}`)
  lines.push('# Main')
  for (const [id, n] of Object.entries(deck.main)) lines.push(`${n} ${id}`)
  lines.push('# Runes')
  for (const [id, n] of Object.entries(deck.runes)) lines.push(`${n} ${id}`)
  lines.push('# Battlefields')
  for (const id of deck.battlefields) lines.push(id)
  if (Object.keys(deck.sideboard).length) {
    lines.push('# Sideboard')
    for (const [id, n] of Object.entries(deck.sideboard)) lines.push(`${n} ${id}`)
  }
  return lines.join('\n')
}

/** A card's display name in the "TCG Arena" convention: drop any trailing
 *  "(Alternate Art)"/"[CODE]" suffix and use a comma subtitle ("Annie, Dark
 *  Child") instead of our internal dash ("Annie - Dark Child"). */
function arenaName(id: string): string {
  const raw = getCard(id)?.name ?? id
  return raw.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').replace(/\s+-\s+/g, ', ').trim()
}

/** Export in the plain "<count> <name>" decklist format used by TCG Arena:
 *  legend, champion, battlefields, runes, then main, then a `Sideboard:` footer.
 *  Same-named cards (e.g. alt-art runes) are aggregated onto one line. */
export function exportDeckArena(deck: Deck): string {
  const lines: string[] = []
  const group = (pairs: Array<[string, number]>) => {
    const agg = new Map<string, number>()
    for (const [id, n] of pairs) { const nm = arenaName(id); agg.set(nm, (agg.get(nm) ?? 0) + n) }
    for (const [nm, n] of agg) lines.push(`${n} ${nm}`)
  }
  if (deck.legendId) lines.push(`1 ${arenaName(deck.legendId)}`)
  if (deck.championId) lines.push(`1 ${arenaName(deck.championId)}`)
  group(deck.battlefields.map((id) => [id, 1]))
  group(Object.entries(deck.runes))
  group(Object.entries(deck.main))
  lines.push('Sideboard:')
  group(Object.entries(deck.sideboard))
  return lines.join('\n')
}

type Section = 'main' | 'runes' | 'battlefields' | 'legend' | 'champion' | 'sideboard' | null

/** Split a card line into count, name, and a code (from [..]/(..) or a trailing
 *  bare id). */
function parseCardLine(line: string): { count: number; name: string; code?: string } {
  const cm = line.match(/^(\d+)\s+/)
  const count = cm ? parseInt(cm[1], 10) : 1
  let rest = (cm ? line.slice(cm[0].length) : line).trim()
  // Code wrapped in [..] or (..) at the end: "Name [UNL-181]" / "Name (OGN-215)".
  const wrapped = rest.match(/[([]\s*([A-Za-z]+-[0-9A-Za-z-]+)\s*[)\]]\s*$/)
  if (wrapped) return { count, name: rest.slice(0, wrapped.index).trim(), code: wrapped[1] }
  // Otherwise the remainder is either a bare id/code or a plain name.
  return { count, name: rest, code: rest }
}

/**
 * Import a decklist into a Deck. Robust across formats:
 *  - our native:      "Name:", "Legend: <id>", "# Main/Runes/Battlefields", "3 <id>"
 *  - flat (no header): "2 Petty Officer (OGN-215)"  → classified by card type
 *  - sectioned:        "Legend:/Champion:/MainDeck:/Battlefields:/Runes:/Sideboard:"
 *                      headers with "1 Jhin, Virtuoso [UNL-181]" lines
 * Each line resolves by code first, then by name. Sideboard is ignored.
 */
export function parseDeck(text: string, id: string): Deck {
  const deck = emptyDeck(id, 'Imported Deck')
  let section: Section = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    // "Name:" — deck name.
    const nameM = line.match(/^name\s*:\s*(.*)$/i)
    if (nameM) {
      deck.name = nameM[1].trim() || deck.name
      continue
    }
    // "Legend:"/"Champion:" — inline ref (native) OR a section header (sectioned).
    const lc = line.match(/^(legend|champion)\s*:\s*(.*)$/i)
    if (lc) {
      const which = lc[1].toLowerCase() as 'legend' | 'champion'
      const rest = lc[2].trim()
      if (rest) {
        const p = parseCardLine(rest)
        const cid = resolveCardRef(p.code, p.name)
        if (cid && which === 'legend') deck.legendId = cid
        if (cid && which === 'champion') deck.championId = cid
      } else {
        section = which
      }
      continue
    }
    // Section headers: "# Main", "MainDeck:", "Runes:", "Battlefields:", "Sideboard:".
    const hdr = line.match(/^#?\s*(main(?:\s*deck)?|runes?|battlefields?|sideboard)\b\s*:?\s*$/i)
    if (hdr) {
      const s = hdr[1].toLowerCase()
      section = s.startsWith('main')
        ? 'main'
        : s.startsWith('rune')
          ? 'runes'
          : s.startsWith('battle')
            ? 'battlefields'
            : 'sideboard'
      continue
    }

    // A card line.
    const { count, name, code } = parseCardLine(line)
    const cid = resolveCardRef(code, name)
    if (!cid) continue // unknown reference — skip rather than store junk

    // Where it goes: explicit section, else by the card's own type.
    let target: Section = section
    if (target === null) {
      const t = getCard(cid)?.type
      target =
        t === 'legend' ? 'legend' : t === 'rune' ? 'runes' : t === 'battlefield' ? 'battlefields' : 'main'
    }
    switch (target) {
      case 'sideboard':
        deck.sideboard[cid] = (deck.sideboard[cid] ?? 0) + count
        break
      case 'legend':
        deck.legendId = cid
        break
      case 'champion':
        // Set the Chosen Champion only — the champion card is also listed under
        // # Main (don't add it again here, or a round-tripped deck double-counts).
        deck.championId = cid
        break
      case 'battlefields':
        if (!deck.battlefields.includes(cid)) deck.battlefields.push(cid)
        break
      case 'main':
      case 'runes':
        deck[target][cid] = (deck[target][cid] ?? 0) + count
        break
    }
  }
  // The Chosen Champion is set aside FROM the main deck — ensure it's present
  // (covers external formats that list it only in a Champion: section).
  if (deck.championId && !deck.main[deck.championId]) deck.main[deck.championId] = 1
  deck.updatedAt = Date.now()
  return deck
}

export function importDeck(text: string): Deck {
  const deck = parseDeck(text, newId())
  return saveDeck(deck)
}
