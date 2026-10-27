import { Component, type ReactNode } from "react"
import { ErrorPageScreen } from "./error-page"

type ErrorBoundaryState = {
  failed: boolean
}

/**
 * Catches render failures that React Router routes cannot handle. A retry is a
 * full reload because in-process state after an uncaught render error is not
 * trustworthy; the boundary never fabricates recovery.
 */
export class PmErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <ErrorPageScreen
          code={500}
          onRetry={() => window.location.reload()}
        />
      )
    }
    return this.props.children
  }
}
