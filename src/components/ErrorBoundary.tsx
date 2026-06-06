import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/** Catches render errors so a single page crash doesn't white-screen the app. */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-md space-y-3 py-20 text-center">
          <div className="text-4xl">💥</div>
          <h2 className="text-xl font-bold">Something went wrong</h2>
          <p className="text-sm text-white/50">{this.state.error.message}</p>
          <button
            onClick={() => {
              this.setState({ error: null })
              location.assign('/')
            }}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold"
          >
            Back to home
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
