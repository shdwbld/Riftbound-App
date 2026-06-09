# Choice-restoration plan — offensive targeting + you-may-pay

Restoring player choices that were auto-decided. Source: 5-agent engine audit (see memory `auto-pick-choice-removal-audit`).

## Architectural reality

The effect engine resolves **synchronously** inside `reduce()`. The only places a
player decision can pause resolution today are:
- **Spell targeting** — UI loop in `MatchPage.tsx` via `needsTarget()`/`getLegalTargets()`
  (effects.ts). Engine "strongest enemy" is a *fallback* when no `targets` are passed.
  Single flat scope (`enemy`|`friendly`|`any`) + a `count`.
- **`pendingChoice`** — board-pick / modal kinds (cullKill, stealUnit, …) resolved by
  `RESOLVE_CHOICE`. Used where a handler can defer in **tail position**.
- **PaymentModal** `payAdditionalCost` — play-time optional costs only.

There is **no** mechanism to pause a *trigger-time*, *death-time*, *conquer-time*, or
*combat-time* effect to ask the player. Building one is the enabling work.

## Tier A — Offensive targeting

| Site | Fires at | Tractability |
|---|---|---|
| dealMight singleEnemy/dealer/foe/bf (5853–5889) | spell resolve | **Med** — extend spell targeting (mixed friendly-dealer + enemy-target needs count/scope work) |
| Strike Down (5737) | spell resolve | Med — dealer + target (2 picks, mixed scope) |
| Void Assault (5763) | spell resolve | Med — unit + enemy + destination bf |
| Rocket Barrage (5817) | spell resolve | Med — "Choose one" mode modal |
| Beast Below (6990), Windsinger (6997), Blast Cone on-play (7186), Quick-Draw (7219) | unit on-play | Med — defer to pendingChoice (tail) |
| Elder Dragon (3936/7120) | on-play chain trigger | Hard — already a chain trigger; add target picker |
| Dragon's Rage collision (7702) | moveToBf resolve | Med — chain a 2nd pendingChoice |
| Caitlyn / activated dealMight (8179) | ACTIVATE_UNIT | **Easy** — activateUnit targeting already exists in UI |
| pullEnemyToBf (2680), applyKillGear (2853) | various | Med |
| Azir-Ascendant which gear (8155) | ACTIVATE_UNIT | Easy-Med |
| champion attack/defend triggers (Ahri/Yasuo/Teemo/TF …) | **combat** | Hard — overlaps auto-resolve preference; likely leave auto |

## Tier B — You-may-pay (optional cost auto-paid)

| Site | Fires at | Tractability |
|---|---|---|
| Blood Rose (2153) | play trigger | Med |
| Vayne conquer (1613) | conquer trigger | Med |
| Ripper's Bay (3608) | returnUnitToHand | Med |
| Immortal Phoenix (2006) | death (fireDeaths) | Hard — mid-death-loop |
| Sett death-save (3729) | death | Hard |
| **Draven (1515), Ava (1789), Sinister Poro (1754)** | **attack/defend (combat)** | **Hardest** — pause combat |

## Build phases

- **P0 (foundation):** generic `pendingChoice` kinds `optionalPay` (yes/no → PaymentModal)
  and `selectTarget` (board-pick) that trigger/death/conquer resolvers can yield to;
  RESOLVE_CHOICE resumes via stored payload. Combat-time deferral is a separate, riskier add.
- **P1:** migrate Easy sites (activated-ability targets: Caitlyn, Azir-Ascendant).
- **P2:** spell-targeting sites (dealMight, Strike Down, Void Assault, Rocket Barrage) — incl. UI mixed-scope/multi-count.
- **P3:** unit on-play offensive targets (Beast Below, Windsinger, Blast Cone, Quick-Draw, Elder Dragon, Dragon's Rage).
- **P4:** non-combat you-may-pay (Blood Rose, Vayne, Ripper's Bay, Immortal Phoenix, Sett).
- **P5 (riskiest, gated):** combat-time triggers (Draven/Ava/Sinister Poro) — needs combat pause/resume.

Every phase: `npx vitest run` gate. All edits sequential in engine.ts (no parallel agents on one file).
