// FILE: browserWebviewHandoff.ts
// Purpose: Bounded ownership transfer for renderer-owned browser webviews across React hosts.
// Layer: Web browser runtime utility
// Depends on: injected scheduler only; DOM/Electron details remain in BrowserPanel.

export interface BrowserWebviewHandoffScheduler<Handle> {
  readonly schedule: (callback: () => void) => Handle;
  readonly cancel: (handle: Handle) => void;
}

interface ParkedBrowserWebview<T, Handle> {
  readonly value: T;
  readonly token: number;
  readonly handle: Handle;
  readonly finalize: (value: T) => void;
}

export interface BrowserWebviewHandoffRegistry<T> {
  readonly park: (key: string, value: T, finalize: (value: T) => void) => void;
  readonly adopt: (key: string) => T | null;
  readonly finalize: (key: string) => boolean;
  readonly has: (key: string) => boolean;
}

interface StableBrowserWebviewNode {
  readonly isConnected: boolean;
  readonly parentNode: unknown;
}

interface StableBrowserWebviewHost<Node> {
  readonly isConnected: boolean;
  readonly append: (node: Node) => void;
}

export interface StableBrowserWebviewRuntime<Node, Host> {
  readonly node: Node;
  readonly host: Host;
}

export function createStableBrowserWebviewRuntime<
  Node extends StableBrowserWebviewNode,
  Host extends StableBrowserWebviewHost<Node>,
>(host: Host, node: Node): StableBrowserWebviewRuntime<Node, Host> | null {
  if (!host.isConnected || node.isConnected) return null;
  host.append(node);
  return isStableBrowserWebviewRuntimeIntact({ host, node }) ? { host, node } : null;
}

export function isStableBrowserWebviewRuntimeIntact<
  Node extends StableBrowserWebviewNode,
  Host extends StableBrowserWebviewHost<Node>,
>(runtime: StableBrowserWebviewRuntime<Node, Host>): boolean {
  return (
    runtime.host.isConnected && runtime.node.isConnected && runtime.node.parentNode === runtime.host
  );
}

export interface BrowserWebviewRuntimeHostGeometry {
  readonly left: string;
  readonly top: string;
  readonly width: string;
  readonly height: string;
  readonly visibility: "visible" | "hidden";
  readonly pointerEvents: "auto" | "none";
  readonly ariaHidden: boolean;
  readonly inert: boolean;
}

export function resolveBrowserWebviewRuntimeHostGeometry(input: {
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly visible: boolean;
}): BrowserWebviewRuntimeHostGeometry {
  return {
    left: `${input.rect.left}px`,
    top: `${input.rect.top}px`,
    width: `${Math.max(0, input.rect.width)}px`,
    height: `${Math.max(0, input.rect.height)}px`,
    visibility: input.visible ? "visible" : "hidden",
    pointerEvents: input.visible ? "auto" : "none",
    ariaHidden: !input.visible,
    inert: !input.visible,
  };
}

export function browserWebviewHandoffKey(input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly partition: string;
}): string {
  return `${input.threadId}\u0000${input.tabId}\u0000${input.partition}`;
}

// Parking is a short lease, never persistent ownership. A successor cancels the bounded
// finalizer by adopting the same key; otherwise finalization runs exactly once.
export function createBrowserWebviewHandoffRegistry<T, Handle>(
  scheduler: BrowserWebviewHandoffScheduler<Handle>,
): BrowserWebviewHandoffRegistry<T> {
  const parkedByKey = new Map<string, ParkedBrowserWebview<T, Handle>>();
  let nextToken = 0;

  const finalizeEntry = (key: string, expectedToken?: number): boolean => {
    const parked = parkedByKey.get(key);
    if (!parked || (expectedToken !== undefined && parked.token !== expectedToken)) {
      return false;
    }
    parkedByKey.delete(key);
    scheduler.cancel(parked.handle);
    parked.finalize(parked.value);
    return true;
  };

  return {
    park: (key, value, finalize) => {
      finalizeEntry(key);
      nextToken += 1;
      const token = nextToken;
      const handle = scheduler.schedule(() => {
        finalizeEntry(key, token);
      });
      parkedByKey.set(key, { value, token, handle, finalize });
    },
    adopt: (key) => {
      const parked = parkedByKey.get(key);
      if (!parked) return null;
      parkedByKey.delete(key);
      scheduler.cancel(parked.handle);
      return parked.value;
    },
    finalize: (key) => finalizeEntry(key),
    has: (key) => parkedByKey.has(key),
  };
}
