import { RELAY_TUNNEL_RELEASED_MESSAGE, type Discovery } from "@t3tools/client-runtime/relay";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  refresh: vi.fn<() => Promise<AtomCommandResult<void, never>>>(),
  register: vi.fn(),
  listEnvironments: vi.fn<() => Promise<DiscoveredEnvironments>>(),
}));

vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? discovery.refresh
        : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => {
    if (discovery.state === null) throw new Error("Discovery fixture is not initialized");
    return discovery.state;
  };
  return {
    ...(await original()),
    useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read),
  };
});

import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";

const newMachineId = EnvironmentId.make("new-computer");
const linkedMachines: DiscoveredEnvironments = new Map([
  [
    newMachineId,
    {
      environment: {
        environmentId: newMachineId,
        label: "Work laptop",
        endpoint: {
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test/ws",
          providerKind: "manual",
        },
        linkedAt: "2026-09-05T12:00:00.000Z",
      },
      availability: "online",
      status: Option.none(),
      error: Option.none(),
    },
  ],
]);

let visibility: DocumentVisibilityState;

function publish(state: Discovery.RelayEnvironmentDiscoveryState) {
  discovery.state = state;
  for (const listener of discovery.listeners) listener();
}

const renderRows = (_fixture: _Fixture, element: ReactElement) =>
  render(element, { container: _fixture.container });

function mount(_fixture: _Fixture, refreshWhileEmpty = true) {
  return renderRows(
    _fixture,
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={null}
      savedEnvironments={[]}
      showSavedEnvironments
      refreshWhileEmpty={refreshWhileEmpty}
      empty={<p>Waiting for your computer to connect.</p>}
    />,
  );
}

const text = (_fixture: _Fixture) => _fixture.container.textContent ?? "";
const button = (_fixture: _Fixture) =>
  [..._fixture.container.querySelectorAll("button")].find((element) => element.textContent !== "");
const checkbox = (_fixture: _Fixture) =>
  _fixture.container.querySelector<HTMLElement>('[role="checkbox"]')!;
const checked = (_fixture: _Fixture) => checkbox(_fixture).getAttribute("aria-checked") === "true";
const toggle = (_fixture: _Fixture) => act(async () => checkbox(_fixture).click());
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function setup(_fixture: _Fixture) {
  using stack = new DisposableStack();
  stack.use(fakeTimers());
  visibility = "visible";
  stack.use(vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility));
  _fixture.container = document.createElement("div");
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.listEnvironments.mockReset().mockResolvedValue(new Map());
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  discovery.refresh.mockReset().mockImplementation(async () => {
    publish({ environments: new Map(), refreshing: true, offline: false, error: Option.none() });
    const environments = await discovery.listEnvironments();
    publish({ environments, refreshing: false, offline: false, error: Option.none() });
    return AsyncResult.success(undefined);
  });
  return stack.move();
}

describe("cloud environment offline reasons", () => {
  it("tells the user to update a computer whose idle tunnel was removed", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    const base = linkedMachines.get(newMachineId)!;
    const offlineEntry = (offlineReason?: "tunnel_released") => ({
      ...base,
      availability: "offline" as const,
      status: Option.some({
        environmentId: newMachineId,
        endpoint: base.environment.endpoint,
        status: "offline" as const,
        checkedAt: "2026-09-15T00:00:00Z",
        error: "Managed endpoint health request failed.",
        ...(offlineReason ? { offlineReason } : {}),
      }),
    });

    discovery.listEnvironments.mockResolvedValue(new Map([[newMachineId, offlineEntry()]]));
    await using _screen = await mount(_fixture);
    expect(text(_fixture)).toContain("T3 Connect · Not added · Relay offline");

    await act(async () => {
      publish({
        environments: new Map([[newMachineId, offlineEntry("tunnel_released")]]),
        refreshing: false,
        offline: false,
        error: Option.none(),
      });
    });
    expect(text(_fixture)).toContain(RELAY_TUNNEL_RELEASED_MESSAGE);
  });
});

describe("cloud onboarding discovery", () => {
  it("signals that the section can expand after initial discovery settles", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    let finishDiscovery!: (environments: DiscoveredEnvironments) => void;
    discovery.listEnvironments.mockReturnValue(
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    );
    const onDiscoveryReady = vi.fn();
    await using _screen = await renderRows(
      _fixture,
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={[]}
        onDiscoveryReady={onDiscoveryReady}
      />,
    );
    expect(onDiscoveryReady).not.toHaveBeenCalled();
    await act(async () => {
      finishDiscovery(linkedMachines);
    });
    expect(onDiscoveryReady).toHaveBeenCalledTimes(1);
    expect(button(_fixture)?.textContent).toBe("Add");
  });

  it("keeps incompatible discoveries unselected until the user enables a compatible server", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    const base = linkedMachines.get(newMachineId)!;
    const entry = (protocolVersion: number) => ({
      ...base,
      status: Option.some({
        environmentId: newMachineId,
        endpoint: base.environment.endpoint,
        status: "online" as const,
        checkedAt: "2026-09-15T00:00:00Z",
        descriptor: {
          environmentId: newMachineId,
          label: base.environment.label,
          platform: { os: "linux" as const, arch: "x64" as const },
          serverVersion: "1.0.0",
          orchestrationProtocolVersion: protocolVersion,
          capabilities: { repositoryIdentity: true },
        },
      }),
    });
    discovery.listEnvironments.mockResolvedValue(
      new Map([[newMachineId, entry(ORCHESTRATION_PROTOCOL_VERSION + 1)]]),
    );
    const onSelectionChange = vi.fn();
    const autoSelectedComputers = new Set<EnvironmentId>();
    function Setup() {
      const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(
        new Set([newMachineId]),
      );
      return (
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          showSavedEnvironments
          selection={{
            autoSelectedComputers,
            selectedIds,
            onChange: (id, checked) => {
              onSelectionChange(id, checked);
              setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              });
            },
          }}
        />
      );
    }
    await using _screen = await renderRows(_fixture, <Setup />);
    expect(discovery.register).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledWith(newMachineId, false);
    expect(checked(_fixture)).toBe(false);
    expect(checkbox(_fixture).hasAttribute("data-disabled")).toBe(true);
    expect(text(_fixture)).toContain("Client not supported");
    expect(text(_fixture)).toContain("Update your app");
    await toggle(_fixture);
    expect(discovery.register).not.toHaveBeenCalled();
    await act(async () =>
      publish({
        ...discovery.state!,
        environments: new Map([[newMachineId, entry(ORCHESTRATION_PROTOCOL_VERSION)]]),
      }),
    );
    expect(discovery.register).not.toHaveBeenCalled();
    expect(checked(_fixture)).toBe(false);
    expect(checkbox(_fixture).hasAttribute("data-disabled")).toBe(false);
    await toggle(_fixture);
    expect(discovery.register).toHaveBeenCalledTimes(1);
  });

  it("connects and selects discovered computers by default without overwriting deselection", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    const autoSelectedComputers = new Set<EnvironmentId>();
    function Setup() {
      const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
      return (
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          showSavedEnvironments
          selection={{
            autoSelectedComputers,
            selectedIds,
            onChange: (id, checked) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              }),
          }}
        />
      );
    }
    await using _screen = await renderRows(_fixture, <Setup />);

    expect(discovery.register).toHaveBeenCalledTimes(1);
    expect(checked(_fixture)).toBe(true);
    await toggle(_fixture);
    await act(async () => {
      publish({ ...discovery.state!, environments: new Map(linkedMachines) });
    });
    expect(checked(_fixture)).toBe(false);
    expect(discovery.register).toHaveBeenCalledTimes(1);
  });

  it("shows a newly linked computer without remounting and stops polling once found", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    discovery.listEnvironments
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(linkedMachines);
    await using _screen = await mount(_fixture);
    expect(text(_fixture)).toBe("Waiting for your computer to connect.");

    await advance(5_000);

    expect(text(_fixture)).toContain("Work laptop");
    expect(button(_fixture)?.textContent).toBe("Add");
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("keeps a discovered computer visible when it is added to the browser", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    await using screen = await mount(_fixture);
    expect(button(_fixture)?.textContent).toBe("Add");
    await screen.rerender(
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={[
          {
            environmentId: newMachineId,
            connection: { phase: "connected", error: null, traceId: null },
            relayManaged: true,
          },
        ]}
        showSavedEnvironments
        refreshWhileEmpty
      />,
    );
    expect(text(_fixture)).toContain("Work laptop");
    expect(button(_fixture)?.textContent).toBe("Connected");
  });

  it("waits while hidden and refreshes immediately when visible again", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    visibility = "hidden";
    await using _screen = await mount(_fixture);
    await advance(30_000);
    expect(discovery.listEnvironments).not.toHaveBeenCalled();

    await act(async () => setVisibility("visible"));
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    window.dispatchEvent(new Event("focus"));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a slow refresh or restart polling after unmount", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    let resolveRefresh!: (environments: DiscoveredEnvironments) => void;
    const pending = new Promise<DiscoveredEnvironments>((resolve) => {
      resolveRefresh = resolve;
    });
    discovery.listEnvironments.mockResolvedValueOnce(new Map()).mockReturnValueOnce(pending);
    await using screen = await mount(_fixture);
    await advance(5_000);
    expect(text(_fixture)).toBe("Waiting for your computer to connect.");

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);

    await screen.unmount();
    await act(async () => resolveRefresh(new Map()));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("pauses while offline and resumes when discovery is online", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    await using _screen = await mount(_fixture);
    await act(async () => publish({ ...discovery.state!, offline: true }));
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);

    await act(async () => publish({ ...discovery.state!, offline: false }));
    await advance(5_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(2);
  });

  it("does not add polling to other cloud lists", async () => {
    await using _fixture = _createFixture();

    using _environment = setup(_fixture);
    await using _screen = await mount(_fixture, false);
    await advance(30_000);
    expect(discovery.listEnvironments).toHaveBeenCalledTimes(1);
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
