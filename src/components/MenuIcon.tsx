// Dependency-free monochrome line-icon set for the radial context menu. Each icon
// is a 24×24 stroke SVG using currentColor, so Tailwind text color drives it. Keys
// cover the menu's action glyphs plus the broad wedge categories. Unknown → 'dot'.

export type IconKey =
  // action glyphs (mapped from the menu's emoji prefixes)
  | 'stun' | 'kill' | 'bolt' | 'recycle' | 'buff' | 'detach' | 'swap' | 'equip'
  | 'coin' | 'eye' | 'eyeOff' | 'back' | 'trash' | 'search' | 'layers' | 'wrench'
  | 'heart' | 'marker' | 'circle' | 'check' | 'arrowRight' | 'sparkle'
  // wedge categories
  | 'actions' | 'status' | 'modify' | 'move' | 'control' | 'owner' | 'gear' | 'hidden'
  // fallback
  | 'dot'

function paths(name: IconKey): React.ReactNode {
  switch (name) {
    case 'stun': return (<><circle cx="12" cy="12" r="8" /><line x1="6.5" y1="6.5" x2="17.5" y2="17.5" /></>)
    case 'kill': return (<><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>)
    case 'bolt': return <path d="M13 2 L4 14 h6 l-1 8 L20 9 h-6 z" />
    case 'recycle': return (<><path d="M5 9a7 7 0 0 1 12-3" /><path d="M19 15a7 7 0 0 1-12 3" /><path d="M17 3v3h-3" /><path d="M7 21v-3h3" /></>)
    case 'buff': return (<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>)
    case 'detach': return (<><path d="M9 15 5.5 18.5a3 3 0 0 1-4-4L5 11" /><path d="M15 9l3.5-3.5a3 3 0 0 1 4 4L19 13" /><line x1="4" y1="4" x2="20" y2="20" /></>)
    case 'swap': return (<><path d="M7 8h11l-3-3" /><path d="M17 16H6l3 3" /></>)
    case 'equip': return (<><path d="M10 14a4 4 0 0 1 0-5l2-2a4 4 0 0 1 6 6l-1 1" /><path d="M14 10a4 4 0 0 1 0 5l-2 2a4 4 0 0 1-6-6l1-1" /></>)
    case 'coin': return (<><circle cx="12" cy="12" r="8" /><path d="M12 8v8M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" /></>)
    case 'eye': return (<><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" /></>)
    case 'eyeOff': return (<><path d="M4 5l16 14" /><path d="M9.5 6.4A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3 3.2" /><path d="M6 7.6A17 17 0 0 0 2 12s4 6 10 6a10 10 0 0 0 3-.5" /></>)
    case 'back': return (<><path d="M9 7l-5 5 5 5" /><path d="M4 12h11a5 5 0 0 1 0 10" /></>)
    case 'trash': return (<><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /></>)
    case 'search': return (<><circle cx="11" cy="11" r="6" /><line x1="20" y1="20" x2="15.5" y2="15.5" /></>)
    case 'layers': return (<><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>)
    case 'wrench': return <path d="M21 4a5 5 0 0 1-6.5 6.5L6 19a2 2 0 0 1-3-3l8.5-8.5A5 5 0 0 1 18 3l-2.5 2.5 1.5 1.5L21 4z" />
    case 'heart': return <path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.4-7 10-7 10z" />
    case 'marker': return (<><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></>)
    case 'circle': return <circle cx="12" cy="12" r="7" />
    case 'check': return <path d="M5 12l4 5 10-11" />
    case 'arrowRight': return (<><line x1="4" y1="12" x2="19" y2="12" /><path d="M13 6l6 6-6 6" /></>)
    case 'sparkle': return <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />
    case 'actions': return (<><line x1="5" y1="7" x2="19" y2="7" /><line x1="5" y1="12" x2="19" y2="12" /><line x1="5" y1="17" x2="13" y2="17" /></>)
    case 'status': return <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />
    case 'modify': return (<><line x1="4" y1="9" x2="20" y2="9" /><circle cx="9" cy="9" r="2.2" fill="currentColor" stroke="none" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="15" cy="16" r="2.2" fill="currentColor" stroke="none" /></>)
    case 'move': return (<><rect x="4" y="9" width="9" height="9" rx="1" /><path d="M14 5h6v6" /><path d="M20 5l-7 7" /></>)
    case 'control': return (<><line x1="6" y1="3" x2="6" y2="21" /><path d="M6 4h11l-2 3 2 3H6" /></>)
    case 'owner': return (<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>)
    case 'gear': return (<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>)
    case 'hidden': return (<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" opacity="0.5" /></>)
    case 'dot':
    default: return <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
  }
}

export default function MenuIcon({ name, className, size = 18 }: { name: IconKey; className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {paths(name)}
    </svg>
  )
}
