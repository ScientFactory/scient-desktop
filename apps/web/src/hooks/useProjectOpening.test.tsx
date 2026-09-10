// @vitest-environment happy-dom
import { act, useCallback, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandDialog, CommandDialogPopup } from "../components/ui/command";
import { createNewThreadNavigationIntentCoordinator } from "../lib/newThreadNavigationIntent";
import { useProjectOpening } from "./useProjectOpening";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let api!: ReturnType<typeof useProjectOpening>;
let setOpen!: (open: boolean) => void;
const closed = vi.fn();
const failed = vi.fn();
const coordinator = createNewThreadNavigationIntentCoordinator();
const claim = vi.fn(() => coordinator.claim({ kind: "explicit", scope: "route" }));

function Probe() {
  const [open, updateOpen] = useState(true);
  const close = useCallback(() => {
    closed();
    updateOpen(false);
  }, []);
  const opening = useProjectOpening(open, close);
  useLayoutEffect(() => {
    api = opening;
    setOpen = updateOpen;
  });
  return (
    <CommandDialog open={open} onOpenChange={updateOpen}>
      <CommandDialogPopup aria-label="Open project">
        <span>{opening.pending ? "Opening…" : "Select a folder"}</span>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  closed.mockClear();
  failed.mockClear();
  claim.mockClear();
  coordinator.invalidate();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Probe />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("project picker opening ownership", () => {
  it("closes the real dialog before navigation settles and coalesces repeated submissions", async () => {
    const preparation = deferred();
    const navigation = deferred();
    const navigate = vi.fn(() => navigation.promise);
    const action = vi.fn(
      async ({ navigationIntent, handoff }: Parameters<Parameters<typeof api.run>[2]>[0]) => {
        await preparation.promise;
        if (!navigationIntent.isCurrent()) return;
        handoff();
        await navigate();
      },
    );
    let result!: Promise<void>;
    await act(() => {
      result = api.run("local:/project", claim, action, failed);
      void api.run("local:/project", claim, action, failed);
    });
    expect(api.pending).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(() => preparation.resolve());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(() => setOpen(true));
    await act(async () => {
      navigation.resolve();
      await result;
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it.each(["dismiss", "different folder", "route change"])(
    "ignores delayed work after %s",
    async (reason) => {
      const preparation = deferred();
      const navigate = vi.fn();
      let result!: Promise<void>;
      await act(() => {
        result = api.run(
          "local:/a",
          claim,
          async ({ navigationIntent, handoff }) => {
            await preparation.promise;
            if (!navigationIntent.isCurrent()) return;
            handoff();
            navigate();
          },
          failed,
        );
      });
      if (reason === "dismiss")
        await act(() => {
          setOpen(false);
        });
      else if (reason === "route change") coordinator.invalidate();
      else await act(() => api.run("remote:/b", claim, async () => {}, failed));
      await act(() => setOpen(true));
      await act(async () => {
        preparation.resolve();
        await result;
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(closed).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "reports failures and allows retry (after handoff: %s)",
    async (handoffFirst) => {
      const navigation = deferred();
      let result!: Promise<void>;
      await act(() => {
        result = api.run(
          "local:/a",
          claim,
          async ({ handoff }) => {
            if (handoffFirst) {
              handoff();
              coordinator.invalidate();
            }
            await navigation.promise;
          },
          failed,
        );
      });
      await act(async () => {
        navigation.reject(new Error("Unavailable"));
        await result;
      });
      expect(failed).toHaveBeenCalledOnce();
      expect(api.pending).toBe(false);
      await act(() => setOpen(true));
      const retry = vi.fn(async () => {});
      await act(() => api.run("local:/a", claim, retry, failed));
      expect(retry).toHaveBeenCalledOnce();
    },
  );
});
