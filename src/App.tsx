import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'

// Route-level code splitting: the heavy pages (card data, engine, Supabase)
// load on demand, keeping the initial bundle small.
const HomePage = lazy(() => import('./pages/HomePage'))
const CardsPage = lazy(() => import('./pages/CardsPage'))
const DecksPage = lazy(() => import('./pages/DecksPage'))
const DeckOverviewPage = lazy(() => import('./pages/DeckOverviewPage'))
const DeckBuilderPage = lazy(() => import('./pages/DeckBuilderPage'))
const PlayPage = lazy(() => import('./pages/PlayPage'))
const MatchPage = lazy(() => import('./pages/MatchPage'))
const OnlinePage = lazy(() => import('./pages/OnlinePage'))

function Loading() {
  return (
    <div className="flex items-center justify-center py-24 text-white/40">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-indigo-400" />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          index
          element={
            <Suspense fallback={<Loading />}>
              <HomePage />
            </Suspense>
          }
        />
        <Route
          path="cards"
          element={
            <Suspense fallback={<Loading />}>
              <CardsPage />
            </Suspense>
          }
        />
        <Route
          path="decks"
          element={
            <Suspense fallback={<Loading />}>
              <DecksPage />
            </Suspense>
          }
        />
        <Route
          path="decks/:id"
          element={
            <Suspense fallback={<Loading />}>
              <DeckOverviewPage />
            </Suspense>
          }
        />
        <Route
          path="decks/:id/edit"
          element={
            <Suspense fallback={<Loading />}>
              <DeckBuilderPage />
            </Suspense>
          }
        />
        <Route
          path="play"
          element={
            <Suspense fallback={<Loading />}>
              <PlayPage />
            </Suspense>
          }
        />
        <Route
          path="match"
          element={
            <Suspense fallback={<Loading />}>
              <MatchPage />
            </Suspense>
          }
        />
        <Route
          path="online"
          element={
            <Suspense fallback={<Loading />}>
              <OnlinePage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
