import { Component, type ReactNode } from 'react'
import { Button } from './Button'
import { Notice } from './Notice'

/** A view that fails to draw shows this instead of an empty panel. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    // Another tab of the panel: try again there.
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="p-3">
        <Notice tone="error" title="This view ran into a problem" actions={<Button size="sm" onClick={() => location.reload()}>Reload the panel</Button>}>
          Nothing was lost: your chats and drafts are kept. The other tabs still work.
        </Notice>
      </div>
    )
  }
}
