// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../ui/toast", () => ({ toastManager: toasts }));

import { ScientForkWorkspaceModeDialog } from "./ScientForkWorkspaceModeDialog";

let root: Root;
let container: HTMLDivElement;
const animationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
beforeEach(() => {
  toasts.add.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // happy-dom has no Web Animations API; exercise the native no-motion exit.
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (animationsDescriptor)
    Object.defineProperty(Element.prototype, "getAnimations", animationsDescriptor);
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "waits for the real dialog exit and restores the form only on navigation failure (%s)",
  async (navigationFails) => {
    let completeSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      completeSetup = resolve;
    });
    const handoff = vi.fn();
    function Probe() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<string | null>(null);
      return (
        <ScientForkWorkspaceModeDialog
          open={open}
          disabled={busy}
          source="this-response"
          proposedTitle="My existing fork title"
          titleOverrideSupported
          worktreeAvailability={{ available: true }}
          error={error}
          onOpenChange={setOpen}
          onConfirm={async (_, closeBeforeNavigate) => {
            setBusy(true);
            await setup;
            const closed = await closeBeforeNavigate();
            handoff(closed);
            if (navigationFails) setError("The fork is ready. Retry to open it.");
            else setOpen(false);
            setBusy(false);
          }}
        />
      );
    }
    await act(() => root.render(<Probe />));
    await act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(handoff).not.toHaveBeenCalled();
    await act(async () => {
      completeSetup();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(handoff).toHaveBeenCalledWith(true);
    });
    if (navigationFails) {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Retry");
      expect(document.querySelector("input")?.value).toBe("My existing fork title");
    } else {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
  },
);

it.each([
  { animation: "pending", navigationFails: false },
  { animation: "pending", navigationFails: true },
  { animation: "cancelled", navigationFails: false },
  { animation: "cancelled", navigationFails: true },
] as const)(
  "removes an accepted fork dialog before navigation with a $animation animation (retry: $navigationFails)",
  async ({ animation, navigationFails }) => {
    let closedAnimationReads = 0;
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: Element) {
        if (this.getAttribute("data-slot") !== "dialog-popup") return [];
        if (animation === "cancelled") {
          if (!this.hasAttribute("data-closed") || closedAnimationReads++ > 0) return [];
          // CSS transitions can be cancelled without a replacement animation.
          return [{ finished: Promise.reject(new DOMException("Cancelled", "AbortError")) }];
        }
        return [{ finished: new Promise<never>(() => {}), playState: "running" }];
      },
    });
    let completeSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      completeSetup = resolve;
    });
    const handoff = vi.fn();
    function Probe() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<string | null>(null);
      return (
        <ScientForkWorkspaceModeDialog
          open={open}
          disabled={busy}
          source="this-response"
          proposedTitle="My fork"
          titleOverrideSupported
          worktreeAvailability={{ available: true }}
          error={error}
          onOpenChange={setOpen}
          onConfirm={async (_, closeBeforeNavigate) => {
            setBusy(true);
            await setup;
            const closed = await closeBeforeNavigate();
            handoff(closed, document.querySelector('[data-slot="dialog-popup"]'));
            if (navigationFails) setError("The fork is ready. Retry to open it.");
            else setOpen(false);
            setBusy(false);
          }}
        />
      );
    }
    await act(() => root.render(<Probe />));
    await act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-slot="dialog-popup"]')).not.toBeNull();
    expect(handoff).not.toHaveBeenCalled();
    await act(async () => completeSetup());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(handoff).toHaveBeenCalledExactlyOnceWith(true, null);
    });
    if (navigationFails) {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Retry");
      expect(document.querySelector("input")?.value).toBe("My fork");
    } else expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
  },
);

it.each([false, true])(
  "can be closed while the fork is being made, and then does not move the user (reopened: %s)",
  async (reopened) => {
    let completeSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      completeSetup = resolve;
    });
    const handoff = vi.fn();
    let reopen!: () => void;
    function Probe() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      reopen = () => setOpen(true);
      return (
        <ScientForkWorkspaceModeDialog
          open={open}
          disabled={busy}
          source="this-response"
          proposedTitle="My fork"
          titleOverrideSupported
          worktreeAvailability={{ available: true }}
          onOpenChange={setOpen}
          onConfirm={async (_, closeBeforeNavigate) => {
            setBusy(true);
            await setup;
            handoff(await closeBeforeNavigate());
            setBusy(false);
          }}
        />
      );
    }
    await act(() => root.render(<Probe />));
    await act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons.some((button) => button.textContent === "Forking…")).toBe(true);
    const close = buttons.find((button) => button.textContent === "Close")!;
    expect(close.disabled).toBe(false);
    await act(() => close.click());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    // Opening the dialog again must not hand the dismissed fork its navigation back.
    if (reopened) await act(() => reopen());

    await act(async () => {
      completeSetup();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(handoff).toHaveBeenCalledWith(false);
    });
    expect(document.querySelector('[role="dialog"]') !== null).toBe(reopened);
  },
);

// What the user did with the dialog before its fork ended, and whether a failure must be notified.
it.each([
  { afterSubmit: "stays open", outcome: "not-accepted", notified: false },
  { afterSubmit: "closed", outcome: "not-accepted", notified: true },
  { afterSubmit: "closed and reopened", outcome: "not-accepted", notified: true },
  { afterSubmit: "reopened and closed again", outcome: "not-accepted", notified: true },
  { afterSubmit: "unmounted", outcome: "not-accepted", notified: true },
  { afterSubmit: "closed", outcome: "accepted", notified: false },
] as const)(
  "notifies a fork failure only when its dialog can no longer show it ($afterSubmit, $outcome)",
  async ({ afterSubmit, outcome, notified }) => {
    let finish!: (outcome: string) => void;
    const forked = new Promise<string>((resolve) => {
      finish = resolve;
    });
    let setDialogOpen!: (open: boolean) => void;
    function Probe() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      setDialogOpen = setOpen;
      return (
        <ScientForkWorkspaceModeDialog
          open={open}
          disabled={busy}
          source="this-response"
          proposedTitle="My fork"
          titleOverrideSupported
          worktreeAvailability={{ available: true }}
          onOpenChange={setOpen}
          onConfirm={async () => {
            setBusy(true);
            const result = await forked;
            setBusy(false);
            return result;
          }}
        />
      );
    }
    await act(() => root.render(<Probe />));
    await act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    if (afterSubmit === "unmounted") {
      await act(() => root.render(null));
    } else if (afterSubmit !== "stays open") {
      await act(() => setDialogOpen(false));
      if (afterSubmit !== "closed") await act(() => setDialogOpen(true));
      if (afterSubmit === "reopened and closed again") await act(() => setDialogOpen(false));
    }

    await act(async () => {
      finish(outcome);
      await forked;
    });
    await act(async () => {});

    expect(toasts.add).toHaveBeenCalledTimes(notified ? 1 : 0);
  },
);

it.each(["continue", "cancel", "unmount"] as const)(
  "resolves unreadable-image confirmation on %s",
  async (action) => {
    const fork = vi.fn();
    function Probe() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      return (
        <ScientForkWorkspaceModeDialog
          open={open}
          disabled={busy}
          source="this-message"
          proposedTitle="My fork"
          titleOverrideSupported
          worktreeAvailability={{ available: true }}
          onOpenChange={setOpen}
          onConfirm={async (_, __, confirmImages) => {
            setBusy(true);
            const proceed = await confirmImages(["missing.png"]);
            if (proceed) fork();
            setBusy(false);
            return proceed ? "accepted" : "not-accepted";
          }}
        />
      );
    }
    await act(() => root.render(<Probe />));
    await act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("missing.png");
    expect(fork).not.toHaveBeenCalled();
    if (action === "unmount") await act(() => root.render(null));
    else
      await act(() => {
        [...document.querySelectorAll("button")]
          .find(
            (button) =>
              button.textContent ===
              (action === "continue" ? "Fork without these images" : "Cancel"),
          )!
          .click();
      });
    await act(async () => {});
    expect(fork).toHaveBeenCalledTimes(action === "continue" ? 1 : 0);
    expect(toasts.add).not.toHaveBeenCalled();
  },
);
