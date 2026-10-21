import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { act, render } from "../../../test/render";

import { DevicePanel } from "./DevicePanel";
import "~/index.css";

type CommandResult =
  | { _tag: "Success"; value: { hostId: string; deviceId: string } }
  | { _tag: "Failure"; cause: unknown };
const mocks = vi.hoisted(() => ({
  open: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  close: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  openDevice: vi.fn(),
  closeSurface: vi.fn(),
}));
const phone = {
  hostId: "local",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS 19",
  booted: false,
  physical: false,
} as const;
const deviceState: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This Mac",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [phone],
  sessions: [
    {
      threadId: ThreadId.make("thread-1"),
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
let currentState = deviceState;
vi.mock("~/state/device", () => ({
  deviceEnvironment: { list: "list", open: "open", close: "close" },
  useDeviceState: () => ({ state: currentState, loaded: true }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "open"
      ? mocks.open
      : command === "close"
        ? mocks.close
        : () => Promise.resolve({ _tag: "Success", value: {} }),
}));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Device failed" }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openDevice: mocks.openDevice, closeSurface: mocks.closeSurface }),
  },
}));
vi.mock("~/components/device/DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("~/components/device/DeviceWorkspace", () => ({
  DeviceWorkspace: ({ onPowerOff }: { onPowerOff: () => void }) => (
    <button onClick={onPowerOff}>Power off</button>
  ),
}));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => (
    <div className="flex h-full min-h-0 flex-col">{children}</div>
  ),
}));

const threadA = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-1"),
};
// The panel stays mounted across both kinds of switch.
const switches = [
  ["another thread", { environmentId: threadA.environmentId, threadId: ThreadId.make("thread-2") }],
  [
    "the same thread id in another environment",
    { ...threadA, environmentId: EnvironmentId.make("environment-b") },
  ],
] as const;
const threadB = switches[0][1];
const otherEnvironment = switches[1][1];
const picker: Extract<RightPanelSurface, { kind: "device" }> = { id: "device", kind: "device" };
const streaming: Extract<RightPanelSurface, { kind: "device" }> = {
  id: "device:phone",
  kind: "device",
  target: { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" },
};
const phoneTarget = { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" };
const opened = { _tag: "Success", value: { hostId: "local", deviceId: "phone" } } as const;
const failed = { _tag: "Failure", cause: new Error("boom") } as const;

const deferred = () => {
  let settle!: (result: CommandResult) => void;
  const promise = new Promise<CommandResult>((resolve) => (settle = resolve));
  return { promise, settle };
};

// Fixed key and a changing threadRef, as RightPanelSurfaceContent mounts it.
const devicePanel = (threadRef: ScopedThreadRef, surface = picker) => (
  <DevicePanel
    key="device-panel"
    mode="embedded"
    threadRef={threadRef}
    surface={surface}
    visible
    onDismissSetup={() => undefined}
  />
);
const startButton = (_fixture: _Fixture) =>
  _fixture.container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]');
const click = (button: HTMLButtonElement | null) =>
  act(async () => {
    button!.click();
  });
const errors = (_fixture: _Fixture) => _fixture.container.querySelectorAll('[role="alert"]');

function setup(_fixture: _Fixture) {
  vi.resetAllMocks();
  currentState = deviceState;
  _fixture.container = document.createElement("div");
  _fixture.container.style.width = "480px";
  _fixture.container.style.height = "800px";
}

describe("DevicePanel notices", () => {
  it("keeps discovery warnings dismissed until the diagnostic or environment changes", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    currentState = {
      ...deviceState,
      hostStatusDetail: "Could not read simulator usage timestamps.",
    };
    await using screen = await render(devicePanel(threadA), { container: _fixture.container });
    expect(errors(_fixture)).toHaveLength(1);
    expect(startButton(_fixture)?.disabled).toBe(false);
    await click(_fixture.container.querySelector('[aria-label="Dismiss device warning"]'));
    expect(errors(_fixture)).toHaveLength(0);
    await screen.rerender(devicePanel(threadA));
    expect(errors(_fixture)).toHaveLength(0);

    currentState = { ...currentState, hostStatusDetail: "A different discovery warning." };
    await screen.rerender(devicePanel(threadA));
    expect(errors(_fixture)).toHaveLength(1);
    await click(_fixture.container.querySelector('[aria-label="Dismiss device warning"]'));
    await screen.rerender(devicePanel(otherEnvironment));
    expect(errors(_fixture)).toHaveLength(1);
  });

  it("keeps the loading content centered when discovery and boot notices arrive or are dismissed", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await using screen = await render(devicePanel(threadA), { container: _fixture.container });
    await click(startButton(_fixture));
    const loadingBounds = () =>
      _fixture.container
        .querySelector('[aria-label="Step 1 of 2: open device"]')!
        .parentElement!.getBoundingClientRect();
    const before = loadingBounds();
    const panel = _fixture.container.getBoundingClientRect();
    expect(before.height).toBeGreaterThan(0);
    expect(before.top + before.height / 2).toBeCloseTo(panel.top + panel.height / 2, 0);

    currentState = {
      ...deviceState,
      hostStatusDetail: "Could not read CoreSimulator plist.\n".repeat(8),
      bootingDevices: [{ ...phone, threadId: threadA.threadId }],
    };
    await screen.rerender(devicePanel(threadA));
    expect(loadingBounds().top).toBe(before.top);
    expect(loadingBounds().left).toBe(before.left);
    await click(_fixture.container.querySelector('[aria-label="Dismiss device warning"]'));
    expect(loadingBounds().top).toBe(before.top);
    expect(loadingBounds().left).toBe(before.left);
    await act(async () => pick.settle(failed));
  });
});

describe("DevicePanel thread switches", () => {
  it.each(switches)("does not carry a pending or failed pick to %s", async (_, target) => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await using screen = await render(devicePanel(threadA), { container: _fixture.container });
    await click(startButton(_fixture));
    expect(startButton(_fixture)).toBeNull();

    await screen.rerender(devicePanel(target));
    expect(startButton(_fixture)?.disabled).toBe(false);

    await act(async () => pick.settle(failed));
    expect(errors(_fixture)).toHaveLength(0);
    expect(mocks.openDevice).not.toHaveBeenCalled();

    await screen.rerender(devicePanel(threadA));
    expect(startButton(_fixture)?.disabled).toBe(false);
    expect(errors(_fixture)).toHaveLength(1);

    await screen.rerender(devicePanel(target));
    expect(startButton(_fixture)?.disabled).toBe(false);
    expect(errors(_fixture)).toHaveLength(0);
  });

  it.each([
    [
      "pick",
      picker,
      () => mocks.open,
      (_fixture: _Fixture) => click(startButton(_fixture)),
      () => expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(threadA, phoneTarget),
    ],
    [
      "power-off",
      streaming,
      () => mocks.close,
      (_fixture: _Fixture) => click(_fixture.container.querySelector("button")),
      () => expect(mocks.closeSurface).toHaveBeenCalledExactlyOnceWith(threadA, streaming.id),
    ],
  ] as const)(
    "applies a late %s to its starting thread after switching environments with the same thread id",
    async (_, surface, command, start, expectApplied) => {
      await using _fixture = _createFixture();

      setup(_fixture);
      const late = deferred();
      command().mockReturnValue(late.promise);
      await using screen = await render(devicePanel(threadA, surface), {
        container: _fixture.container,
      });
      await start(_fixture);

      await screen.rerender(devicePanel(otherEnvironment, surface));
      await act(async () => late.settle(opened));

      expectApplied();
    },
  );

  it("keeps a late power-off error in the environment that started it", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const powerOff = deferred();
    mocks.close.mockReturnValue(powerOff.promise);
    await using screen = await render(devicePanel(threadA, streaming), {
      container: _fixture.container,
    });
    await click(_fixture.container.querySelector("button"));

    await screen.rerender(devicePanel(otherEnvironment, streaming));
    await act(async () => powerOff.settle(failed));

    expect(errors(_fixture)).toHaveLength(0);
    expect(mocks.closeSurface).not.toHaveBeenCalled();
    await screen.rerender(devicePanel(threadA, streaming));
    expect(errors(_fixture)).toHaveLength(1);
  });

  it("keeps the latest pick pending across switches away and back", async () => {
    await using _fixture = _createFixture();

    setup(_fixture);
    const first = deferred();
    const second = deferred();
    const latest = deferred();
    mocks.open
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(latest.promise);
    await using screen = await render(devicePanel(threadA), { container: _fixture.container });
    await click(startButton(_fixture));
    await screen.rerender(devicePanel(threadB));
    await click(startButton(_fixture));
    await screen.rerender(devicePanel(threadA));
    await click(startButton(_fixture));

    await act(async () => first.settle(failed));

    expect(startButton(_fixture)).toBeNull();
    expect(errors(_fixture)).toHaveLength(0);
    expect(mocks.openDevice).not.toHaveBeenCalled();

    await act(async () => second.settle(opened));

    expect(startButton(_fixture)).toBeNull();
    expect(mocks.openDevice.mock.calls).toEqual([[threadB, phoneTarget]]);

    await act(async () => latest.settle(opened));

    expect(startButton(_fixture)?.disabled).toBe(false);
    expect(errors(_fixture)).toHaveLength(0);
    expect(mocks.openDevice.mock.calls).toEqual([
      [threadB, phoneTarget],
      [threadA, phoneTarget],
    ]);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
