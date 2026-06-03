# Riftbound Card-Intent Research & Card-Grammar Framework

This folder is a **research + design** effort (not engine code). Its goal is to
decode what Riftbound cards *intend* to do from their English text, so the
simulator can **tag phrases** and compose behavior instead of hand-coding every
card. Today the engine recognizes ~73% of card-text phrase families; ~27% are a
bespoke "long tail."

## Why
- Understand the **real competitive meta** (not just our 11 app decks) so we know
  which cards/interactions matter most.
- Document **mechanics & symbols** precisely (what each does, the glyph, and where
  on the card it appears).
- Hypothesize a formal **card grammar** that turns English → intended behavior,
  with **conditional triggers stated explicitly as IF/THEN** (the hardest part to
  model).
- Stage a **gap matrix** (intended behavior vs current engine coverage) that a
  later implementation pass can act on.

## Phases & outputs
| Phase | Output | Model |
|------|--------|-------|
| 0 — Scaffold & sources | `README.md`, `sources.md` | — |
| 1 — Meta deck dossiers | `decks/*.md` + `decks/index.md` | Sonnet (parallel) |
| 2 — Mechanics & symbol atlas | `mechanics-and-symbols.md` | Sonnet |
| 3 — Card grammar | `card-grammar.md` | Opus (synthesis) |
| 4 — Gap matrix | `gap-matrix.md` | Opus (synthesis) |
| 5 — Tag-layer implementation (future) | `src/engine/cardIntent.ts` (later) | — |

## How the phases connect
Phase 1 tells us **which cards matter** (meta) and their **intended play lines**.
Phase 2 fixes the **vocabulary** (mechanics/symbols). Phase 3 builds the **grammar**
that maps that vocabulary to behavior and to existing engine handlers. Phase 4
crosses meta cards × grammar × engine to surface **gaps**, ranked by meta impact.

## Reading order
`sources.md` → `decks/index.md` → individual `decks/*.md` →
`mechanics-and-symbols.md` → `card-grammar.md` → `gap-matrix.md`.

## Conventions
- Cards are referenced as **Name (set-id)**, e.g. `Lillia - Bashful Bloom (unl-189-219)`.
- Glyph tokens follow the card data: `:rb_might:`, `:rb_energy_N:`, `:rb_exhaust:`,
  `:rb_rune_<domain>:`, `:rb_rune_rainbow:` (Wild Power). Keywords in `[Brackets]`.
- Conditional triggers are always written **IF \<condition\> THEN \<effect\>**.
- Every external claim cites a source URL (see `sources.md`).

> Unofficial fan research. Not affiliated with Riot Games.
