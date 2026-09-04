// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ScientForkWorkspaceModeDialog } from "./ScientForkWorkspaceModeDialog";

let root: Root;
let container: HTMLDivElement;
const animationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
beforeEach(() => {
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
