// @vitest-environment happy-dom
import type { DesktopCliCommandState } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CliCommandSettingsRow } from "./CliCommandSettingsRow";

const bridge = vi.hoisted(() => ({
  getState: vi.fn<() => Promise<DesktopCliCommandState>>(),
  install: vi.fn<() => Promise<DesktopCliCommandState>>(),
  uninstall: vi.fn<() => Promise<DesktopCliCommandState>>(),
}));
const notices = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../ui/toast", () => ({
  toastManager: notices,
  stackedThreadToast: (notice: unknown) => notice,
}));

describe("desktop CLI shortcut actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: DesktopCliCommandState;
  let previousBridge: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    previousBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { cliCommand: bridge, getLocalEnvironmentBootstraps: () => [] },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    state = { supported: true, installedPath: null, onPath: false, legacyInstalled: true };
    bridge.getState.mockImplementation(async () => state);
    bridge.install.mockImplementation(async () => {
      throw new Error("The canonical launcher is occupied by a foreign file.");
    });
    bridge.uninstall.mockImplementation(async () => {
      state = { supported: true, installedPath: null, onPath: false, legacyInstalled: false };
      return state;
    });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    if (previousBridge) Object.defineProperty(window, "desktopBridge", previousBridge);
    else delete window.desktopBridge;
    vi.unstubAllGlobals();
  });

  function findButton(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  }

  function button(label: string) {
    const found = findButton(label);
    if (!found) throw new Error(`Missing action: ${label}`);
    return found;
  }

  it("offers only installation on fresh setup and removal after canonical installation", async () => {
    state = { supported: true, installedPath: null, onPath: false, legacyInstalled: false };
    bridge.install.mockImplementation(async () => {
      state = { ...state, installedPath: "/fixture/bin/scient", onPath: true };
      return state;
    });
    await act(() => root.render(<CliCommandSettingsRow />));
    expect(findButton("Remove")).toBeUndefined();

    await act(() => button("Install scient").click());
    expect(findButton("Install scient")).toBeUndefined();
    expect(button("Remove").disabled).toBe(false);

    await act(() => button("Remove").click());
    expect(findButton("Remove")).toBeUndefined();
    expect(button("Install scient").disabled).toBe(false);
  });

  it("allows removing legacy shortcuts when canonical installation fails", async () => {
    await act(() => root.render(<CliCommandSettingsRow />));
    await act(() => button("Install scient").click());
    const remove = button("Remove");
    expect(remove.disabled).toBe(false);

    await act(() => remove.click());
    expect(findButton("Remove")).toBeUndefined();
    expect(button("Install scient").disabled).toBe(false);
  });

  it("shows the actual installation after an operation changes state and then fails", async () => {
    bridge.install.mockImplementation(async () => {
      state = { ...state, installedPath: "/fixture/bin/scient", onPath: true };
      throw new Error("A later legacy shortcut could not be refreshed.");
    });
    await act(() => root.render(<CliCommandSettingsRow />));
    await act(() => button("Install scient").click());

    expect(findButton("Install scient")).toBeUndefined();
    expect(button("Remove").disabled).toBe(false);
    await act(() => button("Remove").click());
    expect(button("Install scient").disabled).toBe(false);
  });

  it("keeps both actions disabled until failure-state reconciliation completes", async () => {
    let resolveRefresh!: (value: DesktopCliCommandState) => void;
    const refresh = new Promise<DesktopCliCommandState>((resolve) => {
      resolveRefresh = resolve;
    });
    bridge.getState.mockResolvedValueOnce(state).mockImplementation(() => refresh);
    await act(() => root.render(<CliCommandSettingsRow />));
    await act(() => button("Install scient").click());

    expect(button("Install scient").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    await act(() => button("Remove").click());
    expect(bridge.uninstall).not.toHaveBeenCalled();

    await act(() => resolveRefresh(state));
    expect(button("Install scient").disabled).toBe(false);
    expect(button("Remove").disabled).toBe(false);
  });
});
