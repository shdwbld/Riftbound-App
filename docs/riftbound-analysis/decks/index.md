# Meta deck dossiers — index (Unleashed, June 2026)

Researched from riftbound.gg / riftdecks.com / mobalytics.gg / riftmana.com (Sydney,
Chengdu, Lille regional results). Each dossier has: decklist + set IDs (mapped to our
`cards.generated.json`), mulligan, **turn-by-turn game plan with intended outcome per
step**, and **explicit IF/THEN conditionals**.

| Tier | Deck | Archetype | Dossier |
|------|------|-----------|---------|
| **T1** | Irelia - Blade Dancer | Tempo · board-control (ready-engine) | [irelia-blade-dancer](irelia-blade-dancer.md) |
| **T1** | Diana - Scorn of the Moon | Showdown-dominant midrange | [diana-scorn-of-the-moon](diana-scorn-of-the-moon.md) |
| **T1** | Master Yi - Wuju Bladesman | Control · solo-hold Ambush | [master-yi-wuju-bladesman](master-yi-wuju-bladesman.md) |
| **T1** | LeBlanc - Deceiver | Combo · Deathknell value | [leblanc-deceiver](leblanc-deceiver.md) |
| **T2** | Vex - Gloomist | Control · Calm/Chaos attrition | [vex-gloomist](vex-gloomist.md) |
| **T2** | Sivir - Battle Mistress | Midrange · Aurora-equipment ramp | [sivir-battle-mistress](sivir-battle-mistress.md) |
| **T2** | Azir - Emperor of the Sands | Aggro · Sand Soldier swarm | [azir-emperor-of-the-sands](azir-emperor-of-the-sands.md) |
| Rogue | Vi - Piltover Enforcer | Aggro · Fury/Order excess-damage | [vi-piltover-enforcer](vi-piltover-enforcer.md) |
| Rogue | Nami - Headstrong | Midrange · stun-chain value | [nami-headstrong](nami-headstrong.md) |
| Rogue | LeBlanc (Karthus Deathknell) | Combo · full Deathknell chain | [leblanc-deceiver-karthus-deathknell](leblanc-deceiver-karthus-deathknell.md) |

## Recurring mechanics across the meta (feeds the gap matrix)
The dossiers' IF/THEN lists cluster around a handful of mechanics — these are the
highest-impact things to verify/fix in the engine:
- **Ready-engines** (Irelia legend re-ready, "ready me on conquer") — `readySelf`/ready loop.
- **Excess-damage on conquer** (Vi, Tryndamere ≥5) — `if.excessAtLeast`.
- **Deathknell value chains** (LeBlanc/Karthus) — `on.death` triggers.
- **Hidden combat tricks** (Switcheroo / Fight or Flight / Charm reposition) — see
  [`../diagnostics/hidden.md`](../diagnostics/hidden.md) (mechanic is incomplete).
- **Equipment ramp + Weaponmaster** (Sivir, Azir) — attach + grant-keyword.
- **Move-triggers** ("when X moves, draw") and **stun chains** (Nami).
- **Cost-shaping** (Vex: friendly spells −1 / enemy +1 in combat) — `costMod`.
