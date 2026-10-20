import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "~/components/ServerUpdateAction";
import type { OtherServerUpdate } from "./otherUpdates.logic";

const lab = EnvironmentId.make("lab");

const testState = vi.hoisted(() => ({
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  environments: [] as unknown[],
  providers: new Map<string, ReadonlyArray<ServerProvider>>(),
  serverStates: new Map<string, Atom.Writable<unknown>>(),
  updateProvider: vi.fn<(request: unknown) => Promise<unknown>>(),
  updateServer: vi.fn<(target: unknown, options: unknown) => Promise<unknown>>(),
  updateManaged: vi.fn<(targets: ReadonlyArray<unknown>) => Promise<unknown[]>>(),
  threads: [] as Array<{
    activeRunId: string | null;
    activityRunStatus?: string | null;
    status: string;
  }>,
  run: null as unknown,
  setRun: vi.fn((update: (run: unknown) => unknown) => {
    testState.run = update(testState.run);
  }),
  toasts: [] as Array<{ type: string; title: string }>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
    set: <R, W>(atom: Atom.Writable<R, W>, value: W) => testState.registry!.set(atom, value),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.registry!.update(atom, f),
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  useEnvironmentProviders: () =>
    new Map(
      (testState.environments as Array<ReturnType<typeof remote>>).map((environment) => [
        environment.environmentId,
        testState.providers.get(environment.environmentId) ?? environment.serverConfig.providers,
      ]),
    ),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateProvider: Symbol("update-provider"),
    providersValueAtom: (id: string) =>
      Atom.make(
        () =>
          testState.providers.get(id) ??
          (testState.environments as Array<ReturnType<typeof remote>>).find(
            (environment) => environment.environmentId === id,
          )?.serverConfig.providers ??
          [],
      ),
    updateStateAtom: (id: string) => {
      let atom = testState.serverStates.get(id);
      if (!atom) {
        atom = Atom.make<unknown>({ status: "idle" });
        testState.serverStates.set(id, atom);
      }
      return atom;
    },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));
vi.mock("~/components/ServerUpdateAction", () => ({
  useServerUpdate: () => testState.updateServer,
}));
vi.mock("~/components/sidebar/updateEverythingRun", () => ({
  useUpdateEverythingRun: () => testState.run,
  useQualifiedUpdateRunServers: () => [serverTarget],
  setUpdateEverythingRun: (update: (run: unknown) => unknown) => testState.setRun(update),
  settleUpdateRunMachine: vi.fn(),
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: {
    environmentThreadsAtom: () => Atom.make(() => testState.threads),
  },
}));
vi.mock("~/components/ui/toast", () => ({
  hiddenToastActionProps: { children: null },
  stackedThreadToast: (options: object) => options,
  toastManager: {
    add: (options: { type: string; title: string }) => {
      testState.toasts.push({ type: options.type, title: options.title });
      return "toast";
    },
  },
}));
vi.mock("~/scient/providerConnection/useManagedRuntimeUpdates", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/scient/providerConnection/useManagedRuntimeUpdates")
  >()),
  useManagedRuntimeUpdates: () => ({
    candidates: [],
    targets: [],
    runs: new Map(),
    update: testState.updateManaged,
  }),
}));
vi.mock("~/scient/providerConnection/environmentUpdateWatch", () => ({
  watchEnvironmentProviders: vi.fn(),
}));
vi.mock("~/scient/providerConnection/useProviderLifecycleController", () => ({
  useStartProviderRuntimeAction: vi.fn(),
}));
import { useOtherUpdates } from "./useOtherUpdates";

const serverTarget: ServerUpdateTarget = {
  environmentId: lab,
  serverLabel: "lab-gpu",
  selfUpdate: "boot-service",
  targetVersion: "0.6.21",
};
const serverUpdate: OtherServerUpdate = {
  environmentId: lab,
  label: "lab-gpu",
  app: false,
  fromVersion: "0.6.20",
  toVersion: "0.6.21",
  target: serverTarget,
};

function codexCli(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-10-18T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm i -g @openai/codex",
      canUpdate: true,
      checkedAt: null,
      message: null,
    },
  };
}

function ompManaged(): ServerProvider {
  const { versionAdvisory: _cliAdvisory, ...base } = codexCli();
  return {
    ...base,
    instanceId: ProviderInstanceId.make("omp"),
    driver: ProviderDriverKind.make("omp"),
    connection: {
      methods: [],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "linux-x64",
        actions: ["update"],
        managedVersion: "2.0.0",
        availableManagedVersion: "2.1.0",
        previousManagedVersion: null,
        message: "Managed.",
        operation: null,
      },
    },
  };
}

function remote(providers: ServerProvider[]) {
  return {
    environmentId: lab,
    label: "lab-gpu",
    connection: { phase: "connected" },
    entry: { target: { _tag: "BearerConnectionTarget" } },
    serverConfig: { providers },
  };
}

let renderer: Root | undefined;
let current: ReturnType<typeof useOtherUpdates> | undefined;
function Probe({ servers }: { servers: ReadonlyArray<OtherServerUpdate> }) {
  const value = useOtherUpdates(servers);
  useLayoutEffect(() => {
    current = value;
  });
  return null;
}

async function render(servers: ReadonlyArray<OtherServerUpdate> = []) {
  await act(() => {
    renderer ??= createRoot(document.createElement("div"));
    renderer.render(<Probe servers={servers} />);
  });
}

const states = () => current!.rows.map(({ item, state }) => [item.name, state]);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.registry = AtomRegistry.make();
  testState.serverStates = new Map();
  testState.environments = [];
  testState.providers = new Map();
  testState.updateProvider.mockReset();
  testState.updateServer.mockReset();
  testState.updateManaged.mockReset().mockResolvedValue([]);
  testState.threads = [];
  testState.run = null;
  testState.toasts = [];
  testState.setRun.mockClear();
  current = undefined;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  testState.registry?.dispose();
  vi.unstubAllGlobals();
});

describe("useOtherUpdates", () => {
  it.each(["queued", "running"] as const)(
    "follows a non-default instance's %s update and latest result without a presentation change",
    async (status) => {
      const original = codexCli();
      const defaultProvider = {
        ...original,
        updateState: {
          status: "failed" as const,
          startedAt: null,
          finishedAt: "2026-10-18T09:00:00.000Z",
          message: "Older default failure.",
          output: null,
        },
      };
      const other = {
        ...original,
        instanceId: ProviderInstanceId.make("codex-work"),
        updateState: { ...defaultProvider.updateState, status, finishedAt: null },
      };
      testState.environments = [remote([defaultProvider])];
      testState.providers.set(lab, [defaultProvider, other]);
      await render();
      expect(current!.circle).toBe("updating");
      expect(current!.rows).toMatchObject([
        { item: { instanceId: "codex" }, state: { status: "updating" } },
      ]);

      testState.providers.set(lab, [
        defaultProvider,
        {
          ...other,
          updateState: {
            ...other.updateState,
            status: "succeeded",
            finishedAt: "2026-10-18T10:00:00.000Z",
          },
        },
      ]);
      await render();
      expect(current!.circle).toBe("done");
      expect(current!.rows).toMatchObject([{ state: { status: "done" } }]);

      testState.providers.set(lab, [
        defaultProvider,
        {
          ...other,
          updateState: {
            ...other.updateState,
            status: "failed",
            finishedAt: "2026-10-18T11:00:00.000Z",
            message: "New attempt failed.",
          },
        },
      ]);
      await render();
      expect(current!.circle).toBe("failed");
      expect(current!.rows).toMatchObject([
        { state: { status: "failed", reason: "New attempt failed.", retry: true } },
      ]);
    },
  );

  it("updates one provider in place and offers Retry after its failure", async () => {
    testState.environments = [remote([codexCli()])];
    let finish = (_result: unknown) => {};
    testState.updateProvider.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    expect(current!.circle).toBe("idle");
    await act(async () => current!.update(current!.rows[0]!.item));
    await render();
    expect(testState.updateProvider).toHaveBeenCalledWith({
      environmentId: lab,
      input: { provider: "codex", instanceId: "codex" },
    });
    expect(states()).toEqual([
      ["Codex", { status: "updating", progress: { phase: "installing" } }],
    ]);
    expect(current!.circle).toBe("updating");

    await act(async () => finish(AsyncResult.failure(Cause.fail(new Error("npm exited 1")))));
    await render();
    expect(states()).toEqual([
      ["Codex", { status: "failed", reason: "npm exited 1", retry: true }],
    ]);
    expect(current!.circle).toBe("failed");

    testState.updateProvider.mockResolvedValueOnce(AsyncResult.success({ providers: [] }));
    await act(async () => current!.retry(current!.rows[0]!));
    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
  });

  it("hands a managed runtime to the managed runtime updates", async () => {
    testState.environments = [remote([ompManaged()])];
    await render();
    await act(async () => current!.update(current!.rows[0]!.item));
    expect(testState.updateManaged).toHaveBeenCalledWith([
      expect.objectContaining({ environmentId: lab, driver: "omp", availableVersion: "2.1.0" }),
    ]);
  });

  it("reports a finished server as done until forgotten, then the circle leaves", async () => {
    testState.environments = [remote([])];
    let finish = (_outcome: ServerUpdateOutcome) => {};
    testState.updateServer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render([serverUpdate]);
    expect(states()).toEqual([["lab-gpu server", { status: "idle" }]]);
    await act(async () => current!.update(current!.rows[0]!.item));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget);
    await act(async () => finish({ status: "updated" }));
    // Back on the new version, the server is no longer behind.
    await render([]);
    expect(states()).toEqual([["lab-gpu server", { status: "done" }]]);
    expect(current!.circle).toBe("done");

    await act(async () => current!.forget([current!.rows[0]!.item.key]));
    await render([]);
    expect(current!.rows).toEqual([]);
    expect(current!.circle).toBeNull();
  });

  it("counts the running threads a server update would stop", async () => {
    testState.environments = [remote([])];
    testState.threads = [
      // A running turn with a follow-up queued behind it.
      { activeRunId: "run-1", activityRunStatus: "running", status: "queued" },
      { activeRunId: null, activityRunStatus: null, status: "idle" },
      // An older server without activity runs.
      { activeRunId: null, status: "starting" },
    ];
    await render([serverUpdate]);
    expect(current!.stoppedThreads(current!.rows[0]!.item)).toBe(2);
    // Threads that resume after the restart are not stopped.
    await render([
      {
        ...serverUpdate,
        target: {
          ...serverTarget,
          threadContinuation: true,
          continueThreadsAfterServerUpdate: true,
        },
      },
    ]);
    expect(current!.stoppedThreads(current!.rows[0]!.item)).toBe(0);
  });

  it("holds a server while its machine updates a provider, then offers it again", async () => {
    const running = {
      ...codexCli(),
      updateState: {
        status: "running" as const,
        startedAt: null,
        finishedAt: null,
        message: null,
        output: null,
      },
    };
    testState.environments = [remote([running])];
    await render([serverUpdate]);
    const server = () => current!.rows.find(({ item }) => item.kind === "server")!;
    expect(current!.busy(server().item)).toBe(true);
    // Dispatch reads the machine at the click, so nothing restarts it now.
    await act(async () => current!.update(server().item));
    expect(testState.updateServer).not.toHaveBeenCalled();

    testState.environments = [remote([])];
    testState.updateServer.mockResolvedValueOnce({ status: "updated" });
    await render([serverUpdate]);
    expect(current!.busy(server().item)).toBe(false);
    await act(async () => current!.update(server().item));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget);
  });

  it("releases a server once an interrupted queued provider update ends", async () => {
    const withUpdateState = (status: "queued" | "failed") => ({
      ...codexCli(),
      updateState: {
        status,
        startedAt: null,
        finishedAt: status === "failed" ? "2026-10-18T10:05:00.000Z" : null,
        message: status === "failed" ? "Provider update was interrupted. Try again." : null,
        output: null,
      },
    });
    testState.environments = [remote([withUpdateState("queued")])];
    await render([serverUpdate]);
    const server = () => current!.rows.find(({ item }) => item.kind === "server")!;
    expect(current!.busy(server().item)).toBe(true);

    // The server records the interrupted update as failed rather than leaving it queued.
    testState.environments = [remote([withUpdateState("failed")])];
    testState.updateServer.mockResolvedValueOnce({ status: "updated" });
    await render([serverUpdate]);
    expect(current!.busy(server().item)).toBe(false);
    await act(async () => current!.update(server().item));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget);
  });

  it("holds a server while this card starts a provider update on its machine", async () => {
    testState.environments = [remote([codexCli()])];
    testState.updateProvider.mockImplementationOnce(() => new Promise(() => {}));
    await render([serverUpdate]);
    const row = (kind: string) => current!.rows.find(({ item }) => item.kind === kind)!;
    await act(async () => current!.update(row("provider").item));
    await render([serverUpdate]);
    expect(current!.busy(row("server").item)).toBe(true);
    await act(async () => current!.update(row("server").item));
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("drops a removed machine's rows", async () => {
    await render([serverUpdate]);
    expect(current!.rows).toEqual([]);
    expect(current!.circle).toBeNull();
  });

  it("reports a provider update started here", async () => {
    testState.environments = [remote([codexCli()])];
    testState.updateProvider.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("npm exited 1"))),
    );
    await render();
    await act(async () => current!.update(current!.rows[0]!.item));
    expect(testState.toasts).toEqual([{ type: "error", title: "Provider update failed" }]);
  });

  it("retries a pass's withdrawn server through the pass, keeping its confirmed target", async () => {
    testState.environments = [remote([])];
    testState.run = {
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [
        {
          environmentId: lab,
          label: "lab-gpu",
          updatesProviders: false,
          server: serverTarget,
          handedOffVersion: null,
          startedAt: 0,
          result: "failed",
          failure: "Not updated; it was no longer eligible when servers updated.",
          providerFailure: null,
        },
      ],
    };
    testState.updateServer.mockResolvedValueOnce({ status: "updated" });
    await render([serverUpdate]);
    expect(current!.rows[0]!.state).toMatchObject({ status: "failed", retry: true });
    await act(async () => current!.retry(current!.rows[0]!));
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget, { quiet: false });
    expect(testState.run).toMatchObject({ machines: [{ result: null, failure: null }] });
  });
});
