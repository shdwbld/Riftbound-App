# Gap matrix — meta intent vs engine coverage

**Method.** Cross the 10 meta dossiers' key cards & IF/THEN interactions (≈140
distinct) × the [card grammar](card-grammar.md) × the engine handlers
(`effects.ts`/`keywords.ts`/`triggers.ts`/`engine.ts`). Aggregated by **mechanic**
and ranked by **meta impact** = how many of the 10 decks rely on it. Legend:
✅ works · ⚠️ partial/bespoke · ❌ no handler.

## The matrix (by mechanic, highest meta impact first)

| Mechanic | Decks | Intended behavior (IF → THEN) | Grammar tag(s) | Engine | Representative cards |
|----------|:----:|-------------------------------|----------------|:------:|----------------------|
| **Counter a spell/ability** | 6 | IF an enemy spell/ability chooses a friendly unit/gear THEN counter it (Reaction) | `replacement`/chain | ⚠️ basic chain counter exists; **"counter *unless* controller pays N"** (Hard Bargain) ❌ | Not So Fast, Defy, Hard Bargain |
| **Deathknell value + doubling** | 4 | IF a unit dies THEN its Deathknell fires; IF Karthus in base THEN fires **+1 more time** | `on.death`, `forEach(Karthus)` | ✅ base death; **Karthus doubling ❌**, conditional "die during Beginning Phase → draw 2 else 1" ⚠️ | LeBlanc-Fragmented, Watchful Sentry, Carrion Dredger, Karthus-Eternal |
| **Play a card from deck/trash for free** | 5 | IF \<trigger\> THEN reveal/choose a unit and **play it ignoring cost** | `effect:playFrom(zone)` | ❌ none (no play-from-deck/trash) | Dazzling Aurora, Glasc Mixologist, Fizz-Trickster, Last Rites, Elder Dragon |
| **Stun synergies** | 4 | IF you stun an enemy THEN \<payoff\>; IF target is already stunned THEN \<alt effect\> | `on.stun`, `if.targetStunned` | ✅ stun effect; **"when you stun" trigger ❌**, **"if target stunned" condition ❌** | Eclipse Herald, Leona-Zealot, Existential Dread, Monch, Vex-Apathetic |
| **Ready-engine / re-ready loops** | 4 | IF you conquer/hold THEN ready a unit (or the legend) again | `effect:ready`, `on.conquer` | ✅ ready; **legend self-re-ready on conquer ❌**, Nami "hold → next unit ready+buff" ❌ | Irelia-Blade Dancer, Vi, Nami-Headstrong |
| **"When chosen by your own spell" → buff** | 3 | IF Irelia-Fervent is chosen by your spell/ability THEN +1 Might this turn | `on.targeted(self)` | ❌ no "on becoming a target" trigger | Irelia-Fervent, The Dreaming Tree |
| **Move an ENEMY unit** | 4 | IF you cast Charm/Moonfall THEN move/pull an enemy unit to another battlefield | `effect:moveUnit(enemy,bf)` | ⚠️ move-to-**base** ✅; **move enemy to a chosen battlefield ❌** | Charm, Moonfall, Star-Crossed, Gust |
| **Excess-damage conquer payoffs** | 3 | IF you assigned ≥N excess on conquer THEN \<payoff\> | `if.excessAtLeast`, `grantAssaultHere` | ✅ | Vi, Lord Broadmane, Divining Shells |
| **"Would die" → prevent / heal / recall** | 3 | IF an equipped unit would die THEN kill the gear instead, heal+exhaust+recall the unit | `replacement` | ❌ no replacement/heal layer | Zhonya's Hourglass, Guardian Angel, Sett |
| **Score points directly** | 3 | IF Draven wins combat THEN score +1; IF Mirror token attacks THEN score 2 | `effect:score(N)`, `on.winCombat` | ❌ scoring only via conquer/hold | Draven-Audacious, Mirror Image |
| **Hidden tricks (spells/gear)** | 4 | IF hidden THEN play for 0 at Reaction speed; IF played-from-hidden THEN \<effect\> | `kw:hidden`, `on.playFromHidden` | ❌ spells/gear can't be hidden; reveal≠play — see [hidden.md](diagnostics/hidden.md) | Back Off, Hidden Blade, Fight or Flight, Emperor's Divide, Ember Monk, Edge of Night, Evelynn |
| **Enemy-death triggers** | 3 | IF an enemy unit dies (here/anywhere) THEN \<readies / token\> | `on.death.enemy` | ❌ only friendly-death global trigger | Sivir-Battle Mistress, Pyke-Returned, Kha'Zix |
| **Reflection / copy** | 2 | IF you conquer/hold (discard+exhaust) THEN play a Temporary Reflection copying a unit there | `effect:copy` | ⚠️ bespoke (Mirror Image / LeBlanc / Keeper built) | LeBlanc-Deceiver, Mirror Image, Keeper of Masks |
| **Conditional combat buff (alone/Mighty/while)** | 4 | IF the unit is alone / Mighty / attacking THEN +N Might | `if.alone`, `if.targetMightAtLeast`, `while` | ⚠️ Assault/Shield + some `conditionalMight`; **"alone"/En Garde solo ❌** | Kha'Zix, En Garde, Master Yi solo-hold, Forbidding Waste |
| **Cost-shaping (situational)** | 3 | IF \<state\> THEN this/spells cost ±N | `effect:costMod` (conditional) | ⚠️ static reductions in autopay; **combat/conditional ❌** | Vex (combat ±1), Monch, Hextech Gauntlets (−Might), Noxus Hopeful |
| **XP on kill / win-combat** | 4 | IF you kill / win combat THEN gain N XP | `effect:gainXP` + condition | ✅ gainXP; **per-kill / win-combat-gated ⚠️** | Alpha Strike, Grim Resolve, Kha'Zix, Master Yi Hunt |
| **Reveal hand / force discard** | 2 | IF Mindsplitter enters THEN opponent reveals hand, you choose a discard | `effect:peekDiscard` | ❌ | Mindsplitter, Disposal Order |
| **Predict → conditional reveal** | 2 | IF showdown at Diana (pay 1) THEN Predict; IF top card is a spell THEN draw it free | `effect:predict` + `if.revealType` | ⚠️ Predict peeks 1 (simplified); conditional reveal ❌ | Diana-Lunari, Scryer's Bloom |
| **Battlefield rules (scoring/threshold/tax)** | 5 | IF you hold/conquer \<bf\> THEN \<bespoke\>; threshold/score modifiers | bf scripts | ⚠️ many scripted; **score-threshold mods (Aspirant's Climb, Forgotten Monument) ❌** | Dusk Rose Lab, Star Spring, Amateur Recital, Aspirant's Climb, Mageseeker |
| **Repeat / Accelerate / Ambush** | 7 | optional extra cost → repeat effect / enter ready / play at Reaction | `kw:repeat/accelerate/ambush` | ✅ | Hard Bargain, Rengar, Inferna, Kha'Zix, Tasty Faefolk |
| **Deflect** | 4 | IF an opponent targets this unit THEN they pay +N to do so | `kw:deflect` | ✅ | Master Yi (lvl 6), Rengar, Irelia-Fervent, Vex-Apathetic |

## Top fixes, ranked by meta impact
1. **Play-from-deck/trash for free** (5 decks) — the Aurora/Glasc/Fizz/Last Rites engine; nothing exists. Big build (new `playFrom` effect + targeting).
2. **Hidden mechanic** (4 decks) — see [hidden.md](diagnostics/hidden.md); spells/gear can't be hidden, reveal≠play.
3. **Stun triggers & "if target stunned" conditions** (4 decks) — add `on.stun` event + `if.targetStunned` condition; several payoffs hang off it.
4. **Deathknell doubling (Karthus) + conditional Deathknell** (4 decks) — `forEach` on the death trigger + Beginning-Phase condition.
5. **Enemy-death triggers** (3 decks) — add an `on.death.enemy` scope (Sivir/Pyke engines).
6. **"Would die" replacement layer (heal/recall/prevent)** (3 decks) — the only fully-missing *kind*; unlocks Zhonya's/Guardian Angel/Sett.
7. **Move an enemy unit to a battlefield** (4 decks) — extend the move effect beyond to-base.
8. **Direct scoring effects + win-combat trigger** (3 decks) — `effect:score(N)` + `on.winCombat` payoff.
9. **"On becoming a target" trigger** (3 decks) — Irelia-Fervent's whole identity.
10. **Counter "unless pay N"** + situational cost-shaping (combat ±1) — Hard Bargain, Vex.

## Reading
These rank the engine work by how much *real meta* it unblocks. Each row names the
grammar tag(s) to add (see [card-grammar.md](card-grammar.md) §3) and a concrete
handler site. Fully-missing **kinds** (`replacement`) and **effects** (`playFrom`,
`score`, `peekDiscard`) are the biggest levers; everything else is extending an
existing vocabulary.

---
Inputs: `decks/*.md` (≈140 IF/THEN interactions), `card-grammar.md`,
`mechanics-and-symbols.md`, `src/engine/*.ts`. Unofficial fan research.
