import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import { showBootError } from "./lib/bootError";

class BootElement extends EventTarget {
  children: BootElement[] = [];
  id = "";
  textContent = "";

  constructor(readonly tagName: string) {
    super();
  }

  setAttribute() {}

  append(...children: BootElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: BootElement[]) {
    this.children = children;
  }

  get text(): string {
    return this.textContent + this.children.map((child) => child.text).join(" ");
  }
}

// regression: 6f405370c8 fix(dev): keep shared dev reloads and hot updates working (#9543)
describe("app startup failures", () => {
  let bootShell: BootElement | null;

  beforeEach(() => {
    vi.resetModules();
    bootShell = new BootElement("div");
    vi.stubGlobal("document", {
      getElementById: () => bootShell,
      createElement: (tagName: string) => new BootElement(tagName),
    });
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { reload: vi.fn() } }));
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Test", onLine: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    vi.doUnmock("./main");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("replaces the splash when an app import throws before main can run", async () => {
    vi.doMock("./main", () => {
      throw new Error("@vitejs/plugin-react can't detect preamble. Something is wrong.");
    });
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });

    await import("./bootstrap");
    await vi.dynamicImportSettled();

    expect(bootShell?.text).toContain("Scient could not load.");
    const reloadButton = bootShell?.children[0]?.children[1]?.children.find(
      (element) => element.tagName === "button",
    );
    expect(reloadButton?.text).toBe("Reload");
    reloadButton?.dispatchEvent(new Event("click"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([true, false])("shows startup error details only in dev mode, DEV=%s", (dev) => {
    vi.stubEnv("DEV", dev);

    showBootError(new Error("internal module path"));

    expect(bootShell?.text).toContain("Scient could not load.");
    expect(bootShell?.text.includes("internal module path")).toBe(dev);
  });

  it("keeps native reload and a pending-file restart veto at the boot boundary", async () => {
    vi.useFakeTimers();
    const state = { enabled: true, status: "downloaded" } as DesktopUpdateState;
    const reload = vi.fn();
    const reloadMainWindow = vi.fn(async () => true);
    const installUpdate = vi.fn(async () => ({
      accepted: true,
      completed: false,
      failed: false,
      state,
    }));
    const host = Object.assign(new EventTarget(), {
      location: { reload },
      desktopBridge: {
        reloadMainWindow,
        installUpdate,
        getUpdateState: async () => state,
        onUpdateState: (listener: (value: DesktopUpdateState) => void) => {
          listener(state);
          return () => {};
        },
      },
    });
    vi.stubGlobal("window", host);
    const veto = (event: Event) => event.preventDefault();
    host.addEventListener("beforeunload", veto);
    showBootError(new Error("boot failed"));
    const actions = bootShell?.children[0]?.children[1]?.children ?? [];
    actions
      .find((element) => element.id === "boot-error-reload")
      ?.dispatchEvent(new Event("click"));
    expect(reloadMainWindow).toHaveBeenCalledExactlyOnceWith(false);
    expect(reload).not.toHaveBeenCalled();
    const update = actions.find((element) => element.id === "boot-error-update");
    expect(update).toBeDefined();
    update?.dispatchEvent(new Event("click"));
    expect(installUpdate).not.toHaveBeenCalled();
    expect(bootShell?.text).toContain("Restart paused");
    host.removeEventListener("beforeunload", veto);
    update?.dispatchEvent(new Event("click"));
    expect(installUpdate).toHaveBeenCalledOnce();
    await installUpdate.mock.results[0]!.value;
    expect(bootShell?.text).not.toContain("The update install failed");
  });

  it.each(["download", "install"] as const)(
    "reports an accepted but failed %s result",
    async (kind) => {
      vi.useFakeTimers();
      const state = {
        enabled: true,
        status: kind === "download" ? "available" : "downloaded",
        availableVersion: "0.6.99",
        downloadedVersion: kind === "install" ? "0.6.99" : null,
        errorContext: null,
      } as DesktopUpdateState;
      const action = vi.fn(async () => ({
        accepted: true,
        completed: false,
        state: { ...state, errorContext: kind },
      }));
      vi.stubGlobal(
        "window",
        Object.assign(new EventTarget(), {
          desktopBridge: {
            downloadUpdate: action,
            installUpdate: action,
            getUpdateState: async () => state,
            onUpdateState: (listener: (value: DesktopUpdateState) => void) => {
              listener(state);
              return () => {};
            },
          },
        }),
      );
      showBootError(new Error("boot failed"));
      const update = bootShell?.children[0]?.children[1]?.children.find(
        (element) => element.id === "boot-error-update",
      );
      expect(update).toBeDefined();
      update?.dispatchEvent(new Event("click"));
      expect(action).toHaveBeenCalledOnce();
      await action.mock.results[0]!.value;
      expect(bootShell?.text).toContain(`The update ${kind} failed`);
    },
  );
});
