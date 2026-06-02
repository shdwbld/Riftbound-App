import { DOMAIN_META, type Domain } from '../types/cards'

// Domain-driven visual theming for the board: mats tinted by a player's legend
// domains, and an ambient glow color used for animations.

export function domainColors(domains: Domain[]): string[] {
  return domains.length ? domains.map((d) => DOMAIN_META[d].color) : ['#555']
}

/** A subtle mat gradient tinted by the player's domains. */
export function matGradient(domains: Domain[]): string {
  const c = domainColors(domains)
  if (c.length === 1) return `linear-gradient(135deg, ${c[0]}22, #0a0a12 70%)`
  return `linear-gradient(135deg, ${c[0]}22, ${c[1]}1f, #0a0a12 75%)`
}

/** Primary glow color for a set of domains. */
export function domainGlow(domains: Domain[]): string {
  return domains[0] ? DOMAIN_META[domains[0]].color : '#888'
}

/** Ambient animation class keyed to the primary domain. */
export function domainAnimClass(domains: Domain[]): string {
  switch (domains[0]) {
    case 'fury':
      return 'anim-fury'
    case 'order':
      return 'anim-order'
    case 'mind':
      return 'anim-mind'
    case 'calm':
      return 'anim-calm'
    case 'chaos':
      return 'anim-chaos'
    case 'body':
      return 'anim-body'
    default:
      return ''
  }
}
