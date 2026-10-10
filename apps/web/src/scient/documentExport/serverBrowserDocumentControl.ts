import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";

interface DocumentControl {
  readonly controllingViewerId: string;
  readonly expectedControlGeneration: number;
}
const controls = new Map<string, Map<symbol, DocumentControl>>();

/** Bridges the live viewer lease to linked-source navigation; never persisted or used as browser state. */
export function updateServerBrowserDocumentControl(
  runtimeTabId: string,
  mount: symbol,
  control: PreviewStreamControl | null,
): void {
  const controllingViewerId = control?.controllingViewerId;
  const owned =
    control?.controller === "you" && control.canOperate && controllingViewerId !== undefined;
  let mounts = controls.get(runtimeTabId);
  if (owned) {
    if (!mounts) {
      mounts = new Map();
      controls.set(runtimeTabId, mounts);
    }
    mounts.set(mount, { controllingViewerId, expectedControlGeneration: control.generation });
  } else {
    mounts?.delete(mount);
    if (mounts?.size === 0) controls.delete(runtimeTabId);
  }
}

export function readServerBrowserDocumentControl(runtimeTabId: string): DocumentControl | null {
  return controls.get(runtimeTabId)?.values().next().value ?? null;
}
