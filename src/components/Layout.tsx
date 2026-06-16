import { useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { audio, type SfxName } from '../lib/audio'
import AudioSettings from './AudioSettings'

const navItems = [
  { to: '/', label: 'Home', end: true },
  { to: '/cards', label: 'Cards' },
  { to: '/decks', label: 'Decks' },
  { to: '/play', label: 'Goldfish' },
  { to: '/match', label: 'Match' },
  { to: '/online', label: 'Online' },
  { to: '/bugs', label: 'Bugs' },
  { to: '/cards/spec', label: 'Spec' },
]

/** Pick a click SFX for a pressed control based on its intent (text/aria). */
function clickSfxFor(target: EventTarget | null): SfxName | null {
  if (!(target instanceof Element)) return null
  if (target.closest('[data-no-sfx]')) return null
  const btn = target.closest('button, [role="button"], a')
  if (!btn) return null
  const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase()
  if (/conced|delete|trash|banish|remove|cancel|discard|✕|leave|recycle/.test(label)) return 'undo'
  if (/end turn|\bplay\b|confirm|\bpay\b|\bkeep\b|mulligan|\bstart\b|\broll\b|\bdone\b|create|share|\bload\b|import|\bsave\b|\bjoin\b|\bhost\b/.test(label))
    return 'confirm'
  return 'uiClick'
}

export default function Layout() {
  // The in-match board (Match / Online) goes full-bleed to use the whole desktop;
  // every other page stays centered at max-w-6xl.
  const { pathname } = useLocation()
  // Match / Online boards are full-bleed; the card database also goes edge-to-edge
  // (its sidebar + grid fill the screen). /cards/spec stays centered.
  const fullBleed =
    pathname === '/cards' ||
    ['/match', '/online'].some((p) => pathname === p || pathname.startsWith(p + '/'))

  // Global click SFX: first gesture also unlocks the AudioContext.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const name = clickSfxFor(e.target)
      if (!name) return
      audio.init()
      void audio.play(name, { volume: name === 'uiClick' ? 0.55 : 0.8 })
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // Hover SFX — a subtle tick when the pointer enters an interactive tile, only
  // on the browsable pages (Home / Cards / Decks). The in-match boards (Match /
  // Online) are intentionally excluded. Needs a prior click to unlock audio
  // (autoplay policy), which navigating here always provides.
  const hoverSfxRoutes =
    pathname === '/' || pathname.startsWith('/cards') || pathname.startsWith('/decks')
  useEffect(() => {
    if (!hoverSfxRoutes) return
    let last: Element | null = null
    const onOver = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return
      const el = e.target.closest('a[href], button, [role="button"], [data-hover-sfx]')
      // Reset when over empty space / non-interactive area so re-entering the
      // same tile chimes again; skip the header/footer (content area only).
      if (!el || !el.closest('main') || el.closest('[data-no-sfx], [data-no-hover-sfx]')) {
        last = null
        return
      }
      if (el === last) return
      last = el
      if (!audio.ready) return // don't try to init on hover — it can't unlock
      void audio.play('uiClick', { volume: 0.16, rate: 1.6 })
    }
    document.addEventListener('pointerover', onOver)
    return () => document.removeEventListener('pointerover', onOver)
  }, [hoverSfxRoutes])

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-amber-500/15 bg-[#0a1428]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-3 sm:gap-6 sm:px-4">
          <NavLink to="/" className="flex shrink-0 items-center gap-2 text-lg font-bold">
            <span className="text-xl">⚔️</span>
            <span className="hidden bg-gradient-to-r from-amber-200 to-amber-400 bg-clip-text text-transparent sm:inline">
              Riftbound
            </span>
          </NavLink>
          <nav className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium transition ${
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
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden text-xs text-white/40 lg:block">unofficial simulator</span>
            <AudioSettings />
          </div>
        </div>
      </header>
      <main className={`flex-1 py-6 ${fullBleed ? 'w-full px-3' : 'mx-auto w-full max-w-6xl px-4'}`}>
        <Outlet />
      </main>
      <footer className="border-t border-white/10 px-4 py-4 text-center text-[11px] leading-relaxed text-white/30">
        <p>
          Private, non-commercial fan project — made for personal use among friends, not a public product.
        </p>
        <p className="mx-auto mt-1 max-w-2xl">
          Unofficial and unaffiliated with, and not endorsed or sponsored by, Riot Games. <em>Riftbound</em>,
          <em> League of Legends</em>, all card text, artwork, and audio are the property of Riot Games, Inc. Created
          under Riot's “Legal Jibber Jabber” fan-content policy. No copyright infringement intended; no money is
          made from this. Not for redistribution.
        </p>
      </footer>
    </div>
  )
}
