import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import type { DesktopCliCommandState } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

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
  let state: DesktopCliCommandState;
  let previousBridge: PropertyDescriptor | undefined;

  async function _setupFixture0(_fixture: _Fixture) {
    vi.clearAllMocks();
    previousBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { cliCommand: bridge, getLocalEnvironmentBootstraps: () => [] },
    });
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    state = { supported: true, installedPath: null, onPath: false, legacyInstalled: true };
    bridge.getState.mockImplementation(async () => state);
    bridge.install.mockImplementation(async () => {
      throw new Error("The canonical launcher is occupied by a foreign file.");
    });
    bridge.uninstall.mockImplementation(async () => {
      state = { supported: true, installedPath: null, onPath: false, legacyInstalled: false };
      return state;
    });
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    if (previousBridge) Object.defineProperty(window, "desktopBridge", previousBridge);
    else delete window.desktopBridge;
    vi.unstubAllGlobals();
  }

  function findButton(_fixture: _Fixture, label: string) {
    return [..._fixture.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  }

  function button(_fixture: _Fixture, label: string) {
    const found = findButton(_fixture, label);
    if (!found) throw new Error(`Missing action: ${label}`);
    return found;
  }

  // regression: ad9bf52f2d fix(settings): simplify terminal command actions
  it("offers only installation on fresh setup and removal after canonical installation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state = { supported: true, installedPath: null, onPath: false, legacyInstalled: false };
    bridge.install.mockImplementation(async () => {
      state = { ...state, installedPath: "/fixture/bin/scient", onPath: true };
      return state;
    });
    await act(async () => await _fixture.root0.rerender(<CliCommandSettingsRow />));
    expect(findButton(_fixture, "Remove")).toBeUndefined();

    await act(() => button(_fixture, "Install scient").click());
    expect(findButton(_fixture, "Install scient")).toBeUndefined();
    expect(button(_fixture, "Remove").disabled).toBe(false);

    await act(() => button(_fixture, "Remove").click());
    expect(findButton(_fixture, "Remove")).toBeUndefined();
    expect(button(_fixture, "Install scient").disabled).toBe(false);
  });

  it("allows removing legacy shortcuts when canonical installation fails", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await _fixture.root0.rerender(<CliCommandSettingsRow />));
    await act(() => button(_fixture, "Install scient").click());
    const remove = button(_fixture, "Remove");
    expect(remove.disabled).toBe(false);

    await act(() => remove.click());
    expect(findButton(_fixture, "Remove")).toBeUndefined();
    expect(button(_fixture, "Install scient").disabled).toBe(false);
  });

  it("shows the actual installation after an operation changes state and then fails", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    bridge.install.mockImplementation(async () => {
      state = { ...state, installedPath: "/fixture/bin/scient", onPath: true };
      throw new Error("A later legacy shortcut could not be refreshed.");
    });
    await act(async () => await _fixture.root0.rerender(<CliCommandSettingsRow />));
    await act(() => button(_fixture, "Install scient").click());

    expect(findButton(_fixture, "Install scient")).toBeUndefined();
    expect(button(_fixture, "Remove").disabled).toBe(false);
    await act(() => button(_fixture, "Remove").click());
    expect(button(_fixture, "Install scient").disabled).toBe(false);
  });

  // regression: ad9bf52f2d fix(settings): simplify terminal command actions
  it("keeps both actions disabled until failure-state reconciliation completes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let resolveRefresh!: (value: DesktopCliCommandState) => void;
    const refresh = new Promise<DesktopCliCommandState>((resolve) => {
      resolveRefresh = resolve;
    });
    bridge.getState.mockResolvedValueOnce(state).mockImplementation(() => refresh);
    await act(async () => await _fixture.root0.rerender(<CliCommandSettingsRow />));
    await act(() => button(_fixture, "Install scient").click());

    expect(button(_fixture, "Install scient").disabled).toBe(true);
    expect(button(_fixture, "Remove").disabled).toBe(true);
    await act(() => button(_fixture, "Remove").click());
    expect(bridge.uninstall).not.toHaveBeenCalled();

    await act(() => resolveRefresh(state));
    expect(button(_fixture, "Install scient").disabled).toBe(false);
    expect(button(_fixture, "Remove").disabled).toBe(false);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
