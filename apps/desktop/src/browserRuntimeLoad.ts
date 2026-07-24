// FILE: browserRuntimeLoad.ts
// Purpose: Runs one browser runtime navigation without leaking destroyed-WebContents races.
// Layer: Desktop runtime helper
// Depends on: a minimal Electron WebContents-compatible navigation surface

export interface BrowserRuntimeLoadTarget {
  isDestroyed: () => boolean;
  getURL: () => string;
  loadURL: (url: string) => Promise<void>;
}

export type BrowserRuntimeLoadOutcome = "loaded" | "unchanged" | "aborted" | "stale" | "failed";

interface LoadBrowserRuntimeUrlInput {
  webContents: BrowserRuntimeLoadTarget;
  nextUrl: string;
  force: boolean;
  isCurrent: () => boolean;
  onLoadStart: () => void;
}

function isAbortedNavigationError(error: unknown): boolean {
  return error instanceof Error && /ERR_ABORTED|\(-3\)/i.test(error.message);
}

function runtimeIsStale(input: LoadBrowserRuntimeUrlInput): boolean {
  try {
    return !input.isCurrent() || input.webContents.isDestroyed();
  } catch {
    return true;
  }
}

// Electron can destroy a WebContents between a queued navigation and the async load. Keep every
// WebContents access inside this guarded boundary so stale runtimes resolve benignly rather than
// becoming unhandled promise rejections in the main process.
export async function loadBrowserRuntimeUrl(
  input: LoadBrowserRuntimeUrlInput,
): Promise<BrowserRuntimeLoadOutcome> {
  if (runtimeIsStale(input)) {
    return "stale";
  }

  try {
    const currentUrl = input.webContents.getURL();
    const shouldLoad = input.force || currentUrl.length === 0 || currentUrl !== input.nextUrl;
    if (!shouldLoad) {
      return "unchanged";
    }

    input.onLoadStart();
    await input.webContents.loadURL(input.nextUrl);
    return runtimeIsStale(input) ? "stale" : "loaded";
  } catch (error) {
    if (runtimeIsStale(input)) {
      return "stale";
    }
    return isAbortedNavigationError(error) ? "aborted" : "failed";
  }
}
