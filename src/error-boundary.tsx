import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "./api";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Something went wrong";
    return { hasError: true, message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const details =
      `ErrorBoundary: ${error?.message || String(error)} ${info.componentStack ?? ""}`
        .replace(/\s+/g, " ")
        .trim();
    console.error(details.slice(0, 200));
    // Report the crash to the server (fire-and-forget; never block the fallback UI).
    // Only the crash id, message, stack, url and user agent are sent — never mail content.
    void api
      .reportClientError({
        crashId: crypto.randomUUID(),
        message: (error?.message || String(error)).slice(0, 500),
        stack: (info.componentStack ?? "").slice(0, 4000),
        url: window.location.pathname,
        userAgent: navigator.userAgent,
      })
      .catch(() => {});
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm text-center">
            <h1 className="text-lg font-semibold text-slate-900">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm text-slate-600 break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-5 inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-600 focus:ring-offset-2"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
