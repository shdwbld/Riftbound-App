import { Link } from 'react-router-dom'

const features = [
  {
    to: '/cards',
    title: 'Card Database',
    desc: '1,000+ cards with official art — search by domain, cost, and type.',
    icon: '🃏',
    status: 'Live',
  },
  {
    to: '/decks',
    title: 'Deck Builder',
    desc: 'Build legal decks with a champion legend, runes, and battlefields.',
    icon: '🛠️',
    status: 'Live',
  },
  {
    to: '/play',
    title: 'Play Simulator',
    desc: 'Solo goldfish board now; auto-enforced rules and online multiplayer next.',
    icon: '⚔️',
    status: 'Beta',
  },
]

export default function HomePage() {
  return (
    <div className="space-y-10">
      <section className="rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-950/40 to-fuchsia-950/30 p-8">
        <h1 className="text-3xl font-bold sm:text-4xl">
          The open Riftbound simulator
        </h1>
        <p className="mt-3 max-w-2xl text-white/60">
          A fan-made platform to build decks and play Riftbound online — with a
          full, auto-enforcing rules engine. Currently in active development.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/cards"
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
          >
            Browse cards
          </Link>
          <Link
            to="/play"
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/80 transition hover:bg-white/5"
          >
            Open the board
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <Link
            key={f.to}
            to={f.to}
            className="group rounded-xl border border-white/10 bg-[#15151f] p-5 transition hover:border-white/25 hover:bg-[#1a1a26]"
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl">{f.icon}</span>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/40">
                {f.status}
              </span>
            </div>
            <h3 className="mt-3 font-semibold">{f.title}</h3>
            <p className="mt-1 text-sm text-white/55">{f.desc}</p>
          </Link>
        ))}
      </section>
    </div>
  )
}
