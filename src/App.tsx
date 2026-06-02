import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import CardsPage from './pages/CardsPage'
import DecksPage from './pages/DecksPage'
import DeckBuilderPage from './pages/DeckBuilderPage'
import PlayPage from './pages/PlayPage'
import MatchPage from './pages/MatchPage'
import OnlinePage from './pages/OnlinePage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="cards" element={<CardsPage />} />
        <Route path="decks" element={<DecksPage />} />
        <Route path="decks/:id" element={<DeckBuilderPage />} />
        <Route path="play" element={<PlayPage />} />
        <Route path="match" element={<MatchPage />} />
        <Route path="online" element={<OnlinePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
