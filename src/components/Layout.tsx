import { NavLink, Outlet } from 'react-router-dom'

const navItems = [
  { to: '/', label: 'Home', end: true },
  { to: '/cards', label: 'Cards' },
  { to: '/decks', label: 'Decks' },
  { to: '/play', label: 'Goldfish' },
  { to: '/match', label: 'Match' },
]

export default function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-white/10 bg-[#10101a]/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 text-lg font-bold">
            <span className="text-xl">⚔️</span>
            <span className="bg-gradient-to-r from-indigo-400 to-fuchsia-400 bg-clip-text text-transparent">
              Riftbound
            </span>
          </NavLink>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    isActive
                      ? 'bg-white/10 text-white'
                      : 'text-white/60 hover:bg-white/5 hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto text-xs text-white/40">unofficial simulator</div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-white/10 px-4 py-3 text-center text-xs text-white/30">
        Fan-made Riftbound simulator · Not affiliated with Riot Games
      </footer>
    </div>
  )
}
