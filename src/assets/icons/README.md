# Card symbol icons

Drop real Riftbound in-text symbol icons here and `CardText.tsx` will use them
automatically (it globs this folder). If an icon file is **missing**, the
component falls back to the built-in CSS glyph — so the app works with zero, some,
or all icons present.

## Filenames (svg / png / webp)

Match these base names exactly (lowercase). Extension can be `.svg`, `.png`, or
`.webp`:

| File              | Token in card text         | Meaning                    |
| ----------------- | -------------------------- | -------------------------- |
| `might`           | `:rb_might:`               | Might                      |
| `exhaust`         | `:rb_exhaust:`             | Exhaust / Tap              |
| `recycle`         | `:rb_recycle:`             | Recycle                    |
| `rune-fury`       | `:rb_rune_fury:`           | Fury power (red)           |
| `rune-calm`       | `:rb_rune_calm:`           | Calm power (green)         |
| `rune-mind`       | `:rb_rune_mind:`           | Mind power (blue)          |
| `rune-body`       | `:rb_rune_body:`           | Body power (orange)        |
| `rune-chaos`      | `:rb_rune_chaos:`          | Chaos power (purple)       |
| `rune-order`      | `:rb_rune_order:`          | Order power (yellow)       |
| `rune-wild`       | `:rb_rune_rainbow:`        | Wild power (any domain)    |

`rune-rainbow` is also accepted as an alias for `rune-wild`.

Energy (`:rb_energy_0:`…`:rb_energy_7:`) stays a CSS number-in-circle because the
number is dynamic.

## IP note

These symbols are Riot Games IP. They're fine for a **non-commercial, unofficial
fan tool**, but unlike the card art (which we only hot-link from Riot's CDN),
these files are **hosted by us** — so keep the "unofficial / not affiliated with
Riot Games" disclaimer visible. Use official press-kit/brand assets or a
community icon pack.
