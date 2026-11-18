import type { DesktopBridge } from "@t3tools/contracts";

type SaveBridge = Pick<
  DesktopBridge,
  "onPrepareUpdateSave" | "onReleaseUpdateSave" | "completeUpdateSave"
>;

export interface DesktopUpdateSaveBridgeRegistration {
  readonly register: (handler: () => Promise<boolean>) => () => void;
  readonly installBootShell: () => void;
  readonly dispose: () => void;
}

export function createDesktopUpdateSaveBridge(
  bridge: SaveBridge,
  cleanBootShell: () => boolean,
  lockInput: () => () => void,
) {
  let fullHandler: (() => Promise<boolean>) | null = null;
  let fullHandlerSeen = false;
  let bootShell = false;
  let locked: { requestId: string; restore: () => void } | null = null;
  const release = (requestId: string) => {
    if (locked?.requestId !== requestId) return;
    locked.restore();
    locked = null;
  };
  const unsubscribeRelease = bridge.onReleaseUpdateSave?.(release);
  const unsubscribe = bridge.onPrepareUpdateSave?.(({ requestId, lockForRestart }) => {
    const handler = fullHandler;
    void (async () => {
      let saved = false;
      try {
        if (lockForRestart) {
          if (locked !== null) release(locked.requestId);
          locked = { requestId, restore: lockInput() };
        }
        saved =
          handler !== null
            ? (await handler()) && fullHandler === handler
            : bootShell && !fullHandlerSeen && cleanBootShell();
      } catch {}
      if (!saved) release(requestId);
      try {
        const accepted = await bridge.completeUpdateSave?.({ requestId, saved });
        if (accepted !== true) release(requestId);
      } catch {
        release(requestId);
      }
    })().catch(() => release(requestId));
  });
  return {
    register: (handler: () => Promise<boolean>) => {
      fullHandlerSeen = true;
      fullHandler = handler;
      return () => {
        if (fullHandler === handler) fullHandler = null;
      };
    },
    installBootShell: () => {
      bootShell = true;
    },
    dispose: () => {
      fullHandler = null;
      unsubscribe?.();
      unsubscribeRelease?.();
      if (locked !== null) release(locked.requestId);
    },
  };
}
let singleton: DesktopUpdateSaveBridgeRegistration | null = null;
function getBridge() {
  if (
    singleton === null &&
    window.desktopBridge?.onPrepareUpdateSave &&
    window.desktopBridge.onReleaseUpdateSave &&
    window.desktopBridge.completeUpdateSave
  ) {
    singleton = createDesktopUpdateSaveBridge(
      window.desktopBridge,
      () => window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
      () => {
        const wasInert = document.body.inert;
        document.body.inert = true;
        return () => {
          document.body.inert = wasInert;
        };
      },
    );
  }
  return singleton;
}

export function registerDesktopUpdateSaveHandler(handler: () => Promise<boolean>): () => void {
  return getBridge()?.register(handler) ?? (() => {});
}

/** Before React has ever owned editors, the recovery shell has only native update controls. */
export function installBootErrorUpdateSaveHandling(): void {
  getBridge()?.installBootShell();
}
