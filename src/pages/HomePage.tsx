import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { CARDS } from '../data/cards'

/** Landing destinations, each fronted by a champion splash already in the repo
 *  (public/img/champions/<key>/original.jpg). Splashes are purely cosmetic and
 *  freely swappable. */
const destinations = [
  {
    to: '/cards',
    title: 'Card Database',
    desc: 'Search 1,000+ cards by domain, cost, and type — with official art.',
    icon: '🃏',
    splash: '/img/champions/ahri/original.jpg',
  },
  {
    to: '/decks',
    title: 'Deck Builder',
    desc: 'Forge legal decks — a champion legend, runes, and battlefields.',
    icon: '🛠️',
    splash: '/img/champions/azir/original.jpg',
  },
  {
    to: '/match',
    title: 'Ruled Match',
    desc: 'Hotseat 2-player with fully auto-enforced rules and scoring.',
    icon: '⚔️',
    splash: '/img/champions/darius/original.jpg',
  },
  {
    to: '/online',
    title: 'Play Online',
    desc: 'Room-code multiplayer — same device, or cross-device via Supabase.',
    icon: '🌐',
    splash: '/img/champions/ashe/original.jpg',
  },
  {
    to: '/play',
    title: 'Solo Goldfish',
    desc: 'A free-form board to test draws and sequencing — undo included.',
    icon: '🎴',
    splash: '/img/champions/ezreal/original.jpg',
  },
] as const

const cardCount = CARDS.length

/** Truthful catalog stats (no fake player progression). */
const stats: { value: string; label: string }[] = [
  { value: cardCount >= 1000 ? '1000+' : String(cardCount), label: 'Cards' },
  { value: '6', label: 'Domains' },
  { value: '5', label: 'Modes' },
  { value: 'v1.2', label: 'Ruleset' },
]

export default function HomePage() {
  return (
    <div className="space-y-8">
      {/* ---- Hero: champion splash + scrim + title + CTAs + stats ---------- */}
      <section className="home-hero">
        <div className="home-hero-splash" />
        <div className="home-hero-scrim" />
        <div className="home-hero-content">
          <p className="home-eyebrow">⚔ Unofficial Client · The Climb Begins</p>
          <h1 className="home-title">
            <span className="home-title-sub">The open</span>
            <span className="home-title-main">Riftbound</span>
          </h1>
          <p className="home-blurb">
            A fan-made platform to build decks and play Riftbound online — backed by a
            full, auto-enforcing rules engine.
          </p>

          <div className="home-cta">
            <Link to="/match" className="home-btn home-btn-primary">
              <span className="home-btn-title">Open the board</span>
              <span className="home-btn-sub">Ruled 2-player hotseat</span>
            </Link>
            <Link to="/cards" className="home-btn home-btn-gold">
              Browse cards
            </Link>
            <Link to="/online" className="home-btn home-btn-ghost">
              Play online
            </Link>
          </div>

          <div className="home-stats">
            {stats.map((s) => (
              <div key={s.label} className="home-pill" data-hover-sfx>
                <span className="home-pill-value">{s.value}</span>
                <span className="home-pill-label">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Choose your path: splash tiles ------------------------------- */}
      <section className="space-y-3">
        <div className="home-section-head">
          <h2 className="home-section-label">Choose your path</h2>
          <span className="home-section-hint">5 ways to play</span>
        </div>

        <div className="home-tiles">
          {destinations.map((d, i) => (
            <Link
              key={d.to}
              to={d.to}
              className="home-tile"
              style={{ animationDelay: `${i * 70}ms` } as CSSProperties}
            >
              <div
                className="home-tile-splash"
                style={{ backgroundImage: `url(${d.splash})` }}
              />
              <div className="home-tile-scrim" />
              <div className="home-tile-sheen" />
              <div className="home-tile-body">
                <span className="home-tile-icon">{d.icon}</span>
                <h3 className="home-tile-title">{d.title}</h3>
                <p className="home-tile-desc">{d.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
