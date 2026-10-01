import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * One broken view should not take the whole app down, and it should never fail silently —
 * without this, a render error leaves the previous screen on display and looks like a dead click.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode; where: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.where}]`, error, info.componentStack)
  }

  componentDidUpdate(prev: { children: ReactNode; where: string }) {
    // Navigating elsewhere should clear the error rather than stick on it.
    if (prev.where !== this.props.where && this.state.error) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="content">
        <div className="card stack" style={{ maxWidth: 720 }}>
          <h2 className="section-title" style={{ color: 'var(--danger)' }}>
            {this.props.where} could not render
          </h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap' }}>
            {error.message}
          </div>
          <p className="faint" style={{ margin: 0 }}>
            Everything else still works — your files are untouched. The full stack is in the dev console.
          </p>
        </div>
      </div>
    )
  }
}
