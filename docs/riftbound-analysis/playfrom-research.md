# `playFrom` research — play a card from deck/trash (fix-queue #2)

> **STATUS (implemented):** All 6 patterns now resolve in the engine. The `cc54f4b`
> "trash 3/3" series built A (reveal-until-unit), C (choose-from-trash free), D
> (choose-from-trash energy-only + recycle), and B's auto-play core. This pass added
> **E (full-cost trash play)** for Last Rites (+ a `cards.ts` text-patch restoring its
> dropped conquer/hold bonus), **F (play-from-hand)** for Rift Herald, and routed B
> (`peekBanishPlay`) through `ACTIVATE_UNIT` so activated gear like **Baited Hook**
> resolves (incl. a multi-sentence graft in `unitActivatedAbility` so the deck-dig
> isn't truncated). Known simplifications: Baited Hook's "kill-a-friendly → Might≤
> killed+1" ceiling is unmodeled (auto-plays highest-cost); Last Rites' delivery from
> an attached gear's conquer/hold awaits the separate gear-as-trigger-source fix; and
> `[Add]`/Seal `[Reaction]` timing is still your-turn-only. Tests: `engine.test.ts`
> ("Glasc", "Rift Herald", "full-cost play-from-trash", "Baited Hook", + parse cases).


Implementation-grade research for the **"Play a card from deck/trash for free"** gap
(gap-matrix top fix #1 / handler-coverage fix-queue #2). Produced by a Sonnet research
agent (June 2026, Unleashed meta) reading our dossiers + card data + web rulings. **Fan
research — cite before trusting; rulings flagged with confidence.** All card text quoted
from `src/data/cards.generated.json` unless noted.

---

## 1. The decks that rely on it

| Deck | Tier | Dossier | Play-from-zone card(s) | When it fires |
|------|------|---------|------------------------|---------------|
| **Sivir — Aurora Ramp** | T2 | `sivir-battle-mistress.md` | Dazzling Aurora (`ogn-160-298`); Last Rites (`sfd-150-221`) on Elder Dragon | Aurora: end of every turn (T4+); Last Rites: on conquer/hold |
| **LeBlanc — Deceiver** | T1 | `leblanc-deceiver.md` | Glasc Mixologist (`sfd-165-221`); Baited Hook (`ogn-242-298`); Rift Herald (`unl-179-219`) | Glasc: on death; Baited Hook: activated; Rift Herald: Deathknell |
| **LeBlanc — Karthus Deathknell** | S | `leblanc-deceiver-karthus-deathknell.md` | Glasc Mixologist; Rift Herald | as above; **Karthus doubles** both |
| **Diana — Scorn of the Moon** | T1 | `diana-scorn-of-the-moon.md` | Fizz — Trickster (`sfd-140-221`); Last Rites on Hwei | Fizz: on-play (T4+); Last Rites: on conquer/hold |
| **(5th)** | — | — | **Unconfirmed** — see open question | possibly Rumble — Hotheaded / fringe |

> The gap-matrix says "5 decks" but only **4** are cleanly attributable across our 10
> dossiers. The 5th likely runs a fringe play-from-trash card (Rumble — Hotheaded,
> Soulgorger, Kai'Sa, Heedless Resurrection) not among the top-10 dossiers. Low confidence.

---

## 2. Per-card spec

### Dazzling Aurora — `ogn-160-298` (Gear, Body, 9 Energy)
> "At the end of your turn, reveal cards from the top of your Main Deck until you reveal a unit **and banish it. Play it, ignoring its cost,** and recycle the rest." *(banish clause = Origins errata; already in our data)*

- Zone **deck**, **reveal-until-unit**, **mandatory** (no "may"), **cost ignore = full** (Energy+Power).
- Banish-then-play (errata). Non-units **recycled** (→ bottom of deck, reveal order; **no shuffle**).
- Unit enters **base, exhausted**. Miss (no unit in deck) → recycle all, no play.
- **On-play triggers fire** — drives the Aurora→Elder Dragon combo (free Elder Dragon, its on-play board-wipe resolves). Aurora re-fires every end of turn.

### Glasc Mixologist — `sfd-165-221` (Unit, Order, 5E/1 Order, 5 Might)
> "[Deathknell] — You may play a unit with cost no more than :rb_energy_3: and no more than :rb_rune_rainbow: from your trash, ignoring its cost."

- Trigger **on.death** (Deathknell). Zone **trash**, **choose**, **optional**.
- Filter: **≤3 Energy AND ≤1 rune (any color)**. **Cost ignore = full**.
- Enters **exhausted**; destination = **battlefield where Glasc died** (if still controlled) **or base** (player choice). Cleanup/heal happens between death and Deathknell resolving.
- **Karthus in base → fires twice** = two independent trash-plays.

### Fizz — Trickster — `sfd-140-221` (Champion Unit, Chaos, 3E, 3 Might)
> "When you play me, you may play a **spell** from your trash with Energy cost no more than :rb_energy_3:, **ignoring its Energy cost**. **Recycle** that spell after you play it. **(You must still pay its Power cost.)**"

- Trigger **on.play**. Zone **trash**, **choose**, **optional**, **spells only**, **≤3 Energy**.
- **Cost ignore = energy-only** (rune/Power still paid). Played spell is **recycled** (→ deck bottom), *not* returned to trash.
- Spell's own on-play triggers fire (Diana combo: feeds Ravenbloom Student +1 Might).

### Last Rites — `sfd-150-221` (Gear/Equip, Chaos, 3E; equip = 1 Chaos + Recycle 2)
> "[Equip] — :rb_rune_chaos:, Recycle 2 … When I conquer or hold, you may **play a unit from your trash**. **(You still pay its costs.)**" *(bonus text reconstructed from web; our data only stores the equip line)*

- Trigger **on.conquer / on.hold** of the equipped unit. Zone **trash**, **choose**, **optional**, **any unit (no ceiling)**.
- **Cost ignore = NONE** — full Energy+Power paid; the effect only bypasses the from-hand restriction.
- Enters **exhausted**, base or chosen battlefield.

### Baited Hook — `ogn-242-298` (Gear, Order, 3E — activated)
> ":rb_energy_1::rb_rune_order:, :rb_exhaust:: Kill a friendly unit. Look at the **top 5** of your Main Deck. You may **banish a unit … with Might up to 1 more than the killed unit and play it, ignoring its cost.** Then recycle the rest."

- Trigger **activated**. Zone **deck**, **look-at-top-5 → choose**, **optional**.
- Preceding cost **kill a friendly unit** → sets dynamic ceiling **Might ≤ killed+1**. **Cost ignore = full**. Banish-then-play.
- Enters **exhausted** at **the killed unit's battlefield** (per ruling). Non-chosen recycled.

### Rift Herald — `unl-179-219` (Unit, Order, 8E/1 Order, 7 Might, The Void)
> Move trigger: look top 3, may **draw** a unit (→ hand, *not* play). **[Deathknell]** "Play a unit from your **hand** to your base, **ignoring its Energy cost**. (You must still pay its Power cost.)"

- Deathknell zone **hand**, **energy-only ignore**, destination **base, exhausted**. Effectively optional (hidden-hand privacy). Move trigger is **draw, not play** (out of `playFrom` scope).

---

## 3. Distinct `playFrom` patterns the engine must support

| Pattern | Cards | Shape |
|---------|-------|-------|
| **A. reveal-until-type → play** | Dazzling Aurora | deck, sequential reveal until unit, mandatory, full ignore, recycle rest, banish-first |
| **B. look-top-N → choose → play** | Baited Hook | deck, peek N, dynamic Might ceiling, optional, full ignore, recycle rest, banish-first, dest=source-loc |
| **C. choose-from-trash → play free (cost ceiling)** | Glasc Mixologist (+ Spectral Matron, Undying Loyalty, Heedless Resurrection) | trash, choose, energy/power ceiling, full ignore, optional |
| **D. choose-from-trash → play (energy-only ignore)** | Fizz (+ Kai'Sa, Immortal Phoenix) | trash, choose, **power still paid**, type filter; Fizz recycles the played spell |
| **E. choose-from-trash → play full cost** | Last Rites | trash, choose, **no ignore** (zone bypass only) |
| **F. choose-from-hand → play reduced** | Rift Herald (+ Soulgorger, The Harrowing) | hand, energy-only ignore, dest=base — overlaps the normal play pipeline |
| **G. (NOT playFrom)** reveal-top-N → *draw* | Rift Herald move, Stacked Deck, Scryer's Bloom, Ornn | goes to hand; already a `peekDraw`-style effect |

---

## 4. Implementation gotchas

- **Cost-ignore has 3 modes** — the single biggest distinction: `full` (Aurora/Glasc/Baited Hook) · `energyOnly` / power still paid (Fizz/Rift Herald) · `none` / zone-bypass only (Last Rites). Model as one `costIgnore: 'full'|'energyOnly'|'none'`.
- **It still "counts as playing"** — fires "when you play (a [type])" triggers, increments cards-played-this-turn, satisfies [Legion]. Tokens still don't count. Third-party cost checks use the card's **base** cost (ignore is invisible to them).
- **Banish-before-play** (Aurora, Baited Hook) — track a banish step distinct from trash (banished cards aren't trash-targetable by Last Rites).
- **Destination matters & varies**: Aurora→base; Baited Hook→killed-unit's battlefield; Glasc→Glasc's death-battlefield-or-base (player choice, after cleanup/heal); Rift Herald→base; Last Rites→player choice.
- **Enters exhausted by default.** [Accelerate]'s ready-surcharge is skipped under cost-ignore, so still exhausted. **Rek'Sai — Breacher** aura (already noted in deferred-cards-plan) is the override: at all non-hand play sites, enter **ready** when Breacher is in play — wire that into the `playFrom` site too.
- **No shuffle, ever** — "recycle" = bottom of deck, in reveal order (first revealed sinks deepest; ordering unstated, this is the safe default).
- **Karthus doubling** — Glasc fires twice, two independent trash-plays, sequential.
- **Combat sequencing** — a unit played by a Deathknell during combat enters *after* cleanup/heal; it isn't part of the combat that killed its source but can stage a fresh one if enemies remain (reuse the existing pending-unit/`recruits` finalize flow).

## 5. Proposed effect schema

```ts
interface PlayFromParams {
  zone: 'deck' | 'trash' | 'hand'
  mode: 'revealUntilType' | 'lookAtTopN' | 'chooseFromZone'
  lookCount?: number                 // lookAtTopN (Baited Hook = 5)
  revealFilter?: 'unit'              // reveal/look modes
  typeFilter?: 'unit' | 'spell' | 'gear'   // Fizz = spell
  energyCostCeiling?: number         // Glasc/Fizz = 3
  powerCostCeiling?: number          // Glasc = 1 (rainbow)
  mightCeiling?: 'killedUnit+1'      // Baited Hook
  costIgnore: 'full' | 'energyOnly' | 'none'
  nonPlayedCards?: 'recycle'         // reveal/look modes
  playedCardPost?: 'recycle' | 'normal'   // Fizz spell = recycle
  banishBeforePlay?: boolean         // Aurora, Baited Hook
  optional: boolean                  // Aurora = false, rest = true
  destination?: 'base' | 'sourceLocation' | 'deathLocation' | 'playerChoice'
  entryState?: 'exhausted' | 'ready' // exhausted unless Breacher aura
  countsAsPlay: true                 // always
}
```

## 6. Open questions

1. **Aurora "Play it" mandatory if you don't want the unit?** No "may"; deck contents become public on reveal — likely mandatory, but unconfirmed in errata. Default mandatory + UI confirm. *(medium)*
2. **Ambush units played by Aurora** — can they go to a battlefield instead of base? End-of-turn isn't a Reaction window — likely no. Default base. *(low)*
3. **The 5th deck** — only 4 clearly attributable; 5th is likely a fringe Rumble/Soulgorger/Kai'Sa build. *(low)*
4. **Recycle order of non-played cards** — unstated; default = reveal order (first → deepest).
5. **Heedless Resurrection / fringe Pattern-C variants** — exist in pool, not in top-10 meta; lower priority.

---
Sources: riftbound.gg, riftmana.com, riftboundfaq.com, official Origins errata + Unleashed
Rules FAQ (riftbound.leagueoflegends.com), Core Rules 1.1, plus FB ruling-group posts and the
Riftbound Report. Full URLs in the research transcript. Inputs: `decks/*.md`,
`card-grammar.md`, `gap-matrix.md`, `src/data/cards.generated.json`.
