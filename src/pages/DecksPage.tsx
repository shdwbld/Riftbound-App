import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Link } from 'react-router-dom'
import {
  listDecks,
  createDeck,
  deleteDeck,
  importDeck,
  cloneIntoLibrary,
} from '../lib/deckStorage'
import { getCard } from '../data/cards'
import { pileSize } from '../types/deck'
import { validateDeck } from '../lib/deckValidation'
import { DOMAIN_META, type Domain } from '../types/cards'
import { FEATURED_DECKS, type FeaturedDeck } from '../data/featuredDecks'

export default function DecksPage() {
  const navigate = useNavigate()
  const [decks, setDecks] = useState(() => listDecks())
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')

  const refresh = () => setDecks(listDecks())

  const onCreate = () => {
    const deck = createDeck()
    navigate(`/decks/${deck.id}`)
  }

  const onImport = () => {
    if (!importText.trim()) return
    const deck = importDeck(importText)
    setImporting(false)
    setImportText('')
    navigate(`/decks/${deck.id}`)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">My Decks</h2>
          <p className="text-sm text-white/50">
            {decks.length} {decks.length === 1 ? 'deck' : 'decks'} · saved locally
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setImporting((v) => !v)}
            className="rounded-lg border border-white/15 px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/5"
          >
            Import
          </button>
          <button
            onClick={onCreate}
            className="rounded-lg bg-indigo-500 px-3 py-2 text-sm font-semibold hover:bg-indigo-400"
          >
            + New Deck
          </button>
        </div>
      </div>

      {importing && (
        <div className="space-y-2 rounded-xl border border-white/10 bg-[#15151f] p-4">
          <p className="text-sm text-white/60">Paste a deck code:</p>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            placeholder={'Name: My Deck\nLegend: ...\n# Main\n3 ogn-010-298\n...'}
            className="w-full rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs outline-none focus:border-indigo-400"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setImporting(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-white/60 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={onImport}
              className="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-400"
            >
              Import deck
            </button>
          </div>
        </div>
      )}

      {decks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#15151f] p-10 text-center">
          <div className="text-3xl">🛠️</div>
          <p className="mt-3 font-semibold">No decks yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-white/50">
            Create your first deck — pick a champion legend, add cards, runes,
            and battlefields.
          </p>
          <button
            onClick={onCreate}
            className="mt-4 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold hover:bg-indigo-400"
          >
            + New Deck
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {decks.map((deck) => {
            const legend = deck.legendId ? getCard(deck.legendId) : undefined
            const v = validateDeck(deck)
            return (
              <Link
                key={deck.id}
                to={`/decks/${deck.id}`}
                className="group relative overflow-hidden rounded-xl border border-white/10 bg-[#15151f] p-4 transition hover:border-white/25 hover:bg-[#1a1a26]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{deck.name}</div>
                    <div className="truncate text-xs text-white/50">
                      {legend ? legend.name : 'No legend'}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                      v.isLegal
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-amber-500/20 text-amber-300'
                    }`}
                  >
                    {v.isLegal ? 'legal' : 'draft'}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-white/50">
                  <span>{pileSize(deck.main)}/40 main</span>
                  <span>·</span>
                  <span>{pileSize(deck.runes)}/12 runes</span>
                  <span>·</span>
                  <span>{deck.battlefields.length}/3 BF</span>
                </div>
                <div className="mt-2 flex gap-1">
                  {v.identity.map((d) => (
                    <span
                      key={d}
                      className="h-2 w-6 rounded-full"
                      style={{ background: DOMAIN_META[d].color }}
                      title={DOMAIN_META[d].label}
                    />
                  ))}
                </div>
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    if (confirm(`Delete "${deck.name}"?`)) {
                      deleteDeck(deck.id)
                      refresh()
                    }
                  }}
                  className="absolute bottom-3 right-3 rounded px-2 py-1 text-xs text-white/30 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-300 group-hover:opacity-100"
                >
                  Delete
                </button>
              </Link>
            )
          })}
        </div>
      )}

      <FeaturedDecks
        onCopy={(f) => {
          const deck = cloneIntoLibrary({
            name: f.name,
            legendId: f.legendId,
            main: f.main,
            runes: f.runes,
            battlefields: f.battlefields,
          })
          navigate(`/decks/${deck.id}`)
        }}
      />
    </div>
  )
}

function FeaturedDecks({ onCopy }: { onCopy: (f: FeaturedDeck) => void }) {
  const groups: FeaturedDeck['group'][] = ['Champion Deck', 'Proving Grounds']
  return (
    <section className="space-y-4 pt-4">
      <div>
        <h2 className="text-xl font-bold">Starter Decks</h2>
        <p className="text-xs text-white/40">
          The 7 official champions — legal, on-theme builds you can copy and tweak.
          Not Riot's exact preconstructed lists.
        </p>
      </div>
      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">
            {g === 'Champion Deck' ? 'Champion Decks' : 'Proving Grounds'}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURED_DECKS.filter((f) => f.group === g).map((f) => {
              const legend = getCard(f.legendId)
              const identity =
                legend && legend.type === 'legend' ? legend.identity : []
              return (
                <div
                  key={f.id}
                  className="flex gap-3 overflow-hidden rounded-xl border border-white/10 bg-[#15151f] p-3 transition hover:border-white/25"
                >
                  {legend?.imageUrl && (
                    <img
                      src={legend.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-24 w-[68px] shrink-0 rounded object-cover"
                    />
                  )}
                  <div className="flex min-w-0 flex-col">
                    <div className="truncate text-sm font-semibold">{f.champion}</div>
                    <div className="text-[11px] text-white/50">{f.archetype}</div>
                    <div className="mt-1 flex gap-1">
                      {(identity as Domain[]).map((d) => (
                        <span
                          key={d}
                          className="h-2 w-6 rounded-full"
                          style={{ background: DOMAIN_META[d].color }}
                          title={DOMAIN_META[d].label}
                        />
                      ))}
                    </div>
                    <button
                      onClick={() => onCopy(f)}
                      className="mt-auto rounded-lg bg-indigo-500/80 px-3 py-1.5 text-xs font-semibold hover:bg-indigo-500"
                    >
                      Copy to my decks
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}
