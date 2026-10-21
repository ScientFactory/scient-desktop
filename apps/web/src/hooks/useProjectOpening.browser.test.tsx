import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { useLayoutEffect, useState } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
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

const closed = vi.fn();
const failed = vi.fn();
const coordinator = createNewThreadNavigationIntentCoordinator();
const claim = vi.fn(() => coordinator.claim({ kind: "explicit", scope: "route" }));

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const [open, updateOpen] = useState(true);
  const close = () => {
    closed();
    updateOpen(false);
  };
  const opening = useProjectOpening(open, close);
  useLayoutEffect(() => {
    _fixture.publishApi(opening);
    _fixture.publishSetOpen(updateOpen);
  });
  return (
    <CommandDialog open={open} onOpenChange={updateOpen}>
      <CommandDialogPopup aria-label="Open project">
        <span>{opening.pending ? "Opening…" : "Select a folder"}</span>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
async function _setupFixture0(_fixture: _Fixture) {
  closed.mockClear();
  failed.mockClear();
  claim.mockClear();
  coordinator.invalidate();
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

describe("project picker opening ownership", () => {
  it("closes the real dialog before navigation settles and coalesces repeated submissions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const preparation = deferred();
    const navigation = deferred();
    const navigate = vi.fn(() => navigation.promise);
    const action = vi.fn(
      async ({
        navigationIntent,
        handoff,
      }: Parameters<Parameters<typeof _fixture.api.run>[2]>[0]) => {
        await preparation.promise;
        if (!navigationIntent.isCurrent()) return;
        handoff();
        await navigate();
      },
    );
    let result!: Promise<void>;
    await act(() => {
      result = _fixture.api.run("local:/project", claim, action, failed);
      void _fixture.api.run("local:/project", claim, action, failed);
    });
    expect(_fixture.api.pending).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(() => preparation.resolve());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    await act(() => _fixture.setOpen(true));
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const preparation = deferred();
      const navigate = vi.fn();
      let result!: Promise<void>;
      await act(() => {
        result = _fixture.api.run(
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
          _fixture.setOpen(false);
        });
      else if (reason === "route change") coordinator.invalidate();
      else await act(() => _fixture.api.run("remote:/b", claim, async () => {}, failed));
      await act(() => _fixture.setOpen(true));
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const navigation = deferred();
      let result!: Promise<void>;
      await act(() => {
        result = _fixture.api.run(
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
      expect(_fixture.api.pending).toBe(false);
      await act(() => _fixture.setOpen(true));
      const retry = vi.fn(async () => {});
      await act(() => _fixture.api.run("local:/a", claim, retry, failed));
      expect(retry).toHaveBeenCalledOnce();
    },
  );
});

function _createFixture() {
  let _published_api = undefined! as ReturnType<typeof useProjectOpening>;
  let _published_setOpen = undefined! as (open: boolean) => void;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get setOpen() {
      return _published_setOpen;
    },
    publishSetOpen(next: typeof _published_setOpen) {
      _published_setOpen = next;
    },
    get api() {
      return _published_api;
    },
    publishApi(next: typeof _published_api) {
      _published_api = next;
    },

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
