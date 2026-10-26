import { Component, type ReactNode } from "react";

/** Keeps a failing part of the UI from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-start gap-2 p-4 text-sm">
        <p className="text-destructive">{this.props.label} failed to load.</p>
        <pre className="max-w-full overflow-auto text-xs whitespace-pre-wrap text-muted-foreground">
          {this.state.error.message}
        </pre>
        <button className="text-xs underline" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
