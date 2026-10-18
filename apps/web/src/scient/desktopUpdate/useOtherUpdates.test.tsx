import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "~/components/ServerUpdateAction";
import type { OtherServerUpdate } from "./otherUpdates.logic";

const lab = EnvironmentId.make("lab");

const testState = vi.hoisted(() => ({
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  environments: [] as unknown[],
  serverStates: new Map<string, Atom.Writable<unknown>>(),
  updateProvider: vi.fn<(request: unknown) => Promise<unknown>>(),
  updateServer: vi.fn<(target: unknown, options: unknown) => Promise<unknown>>(),
  updateManaged: vi.fn<(targets: ReadonlyArray<unknown>) => Promise<unknown[]>>(),
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
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateProvider: Symbol("update-provider"),
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
  useUpdateEverythingRun: () => null,
  useQualifiedUpdateRunServers: () => [serverTarget],
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

let renderer: ReactTestRenderer | undefined;
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
    if (renderer) renderer.update(<Probe servers={servers} />);
    else renderer = create(<Probe servers={servers} />);
  });
}

const states = () => current!.rows.map(({ item, state }) => [item.name, state]);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.registry = AtomRegistry.make();
  testState.serverStates = new Map();
  testState.environments = [];
  testState.updateProvider.mockReset();
  testState.updateServer.mockReset();
  testState.updateManaged.mockReset().mockResolvedValue([]);
  current = undefined;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  testState.registry?.dispose();
  vi.unstubAllGlobals();
});

describe("useOtherUpdates", () => {
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
    expect(testState.updateServer).toHaveBeenCalledWith(serverTarget, { quiet: true });
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

  it("lists a manual item without acting on it", async () => {
    await render([{ ...serverUpdate, target: null }]);
    expect(current!.rows[0]).toMatchObject({ item: { manual: true }, state: { status: "idle" } });
    await act(async () => current!.update(current!.rows[0]!.item));
    expect(testState.updateServer).not.toHaveBeenCalled();
  });
});
