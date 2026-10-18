import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
    serverConfig: { providers: ServerProvider[] } | null;
  }>,
  configs: new Map<string, Atom.Writable<{ providers: ServerProvider[] } | null>>(),
  startRuntimeAction: vi.fn<(input: unknown) => Promise<ServerProvider>>(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.registry!.update(atom, f),
    subscribe: <A,>(
      atom: Atom.Atom<A>,
      f: (value: A) => void,
      options?: { readonly immediate?: boolean },
    ) => testState.registry!.subscribe(atom, f, options),
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: (id: string) => testState.configs.get(id)! },
}));
vi.mock("./useProviderLifecycleController", () => ({
  useStartProviderRuntimeAction: () => testState.startRuntimeAction,
}));

import {
  connectedProviderEnvironments,
  managedRuntimeProviderMachines,
  managedRuntimeRunOutcomes,
  useManagedRuntimeUpdates,
} from "./useManagedRuntimeUpdates";

const lab = EnvironmentId.make("lab");
type Runs = Awaited<ReturnType<ReturnType<typeof useManagedRuntimeUpdates>["update"]>>;

function codex(
  patch: {
    readonly managedVersion?: string;
    readonly source?: "scient_managed" | "system";
    readonly operation?: Partial<ProviderRuntimeOperation> | null;
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: patch.managedVersion ?? "0.157.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-10-18T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: [],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: patch.source ?? "scient_managed",
        supportTier: "fully_assisted",
        target: "linux-x64",
        actions: ["update", "repair", "remove"],
        managedVersion: patch.managedVersion ?? "0.157.0",
        availableManagedVersion: "0.157.1",
        previousManagedVersion: null,
        message: "Managed Codex.",
        operation: patch.operation
          ? {
              operationId: "op-1",
              action: "update",
              status: "downloading",
              startedAt: "2026-10-18T10:00:00.000Z",
              finishedAt: null,
              message: "Downloading.",
              ...patch.operation,
            }
          : null,
      },
    },
  };
}

let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useManagedRuntimeUpdates> | undefined;
function Probe() {
  const value = useManagedRuntimeUpdates();
  useLayoutEffect(() => {
    current = value;
  });
  return null;
}

function publish(providers: ServerProvider[]) {
  testState.registry!.set(testState.configs.get(lab)!, { providers });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.registry = AtomRegistry.make();
  testState.environments = [
    {
      environmentId: lab,
      label: "lab",
      connection: { phase: "connected" },
      serverConfig: { providers: [codex()] },
    },
  ];
  testState.configs = new Map([
    [lab, Atom.make<{ providers: ServerProvider[] } | null>({ providers: [codex()] })],
  ]);
  testState.startRuntimeAction
    .mockReset()
    .mockResolvedValue(codex({ operation: { status: "preparing" } }));
  current = undefined;
  await act(() => {
    renderer = create(<Probe />);
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  testState.registry?.dispose();
  vi.unstubAllGlobals();
});

describe("useManagedRuntimeUpdates", () => {
  it("offers one runtime per connected machine and driver", () => {
    expect(current!.targets).toEqual([
      {
        environmentId: lab,
        environmentLabel: "lab",
        instanceId: "codex",
        driver: "codex",
        availableVersion: "0.157.1",
      },
    ]);
  });

  it("hands off a runtime staged to switch when idle, then records its result", async () => {
    let settled = false;
    let runs: Runs = [];
    await act(async () => {
      void current!.update(current!.targets).then((result) => {
        settled = true;
        runs = result;
      });
    });
    expect(testState.startRuntimeAction).toHaveBeenCalledWith({
      environmentId: lab,
      instanceId: "codex",
      action: "update",
    });
    expect(settled).toBe(false);

    await act(async () => {
      publish([
        codex({
          operation: { status: "activating", waitingForIdle: true, message: "Waiting for a turn." },
        }),
      ]);
    });
    expect(settled).toBe(true);
    expect(runs[0]).toMatchObject({
      outcome: { status: "pending" },
      waitingMessage: "Waiting for a turn.",
    });

    await act(async () => {
      publish([codex({ managedVersion: "0.157.1", operation: { status: "succeeded" } })]);
    });
    await act(() => renderer!.update(<Probe />));
    expect([...current!.runs.values()][0]).toMatchObject({
      outcome: { status: "succeeded", version: "0.157.1" },
    });
  });

  it("settles a failed start without following it", async () => {
    testState.startRuntimeAction.mockRejectedValueOnce(new Error("No catalog."));
    let runs: Runs = [];
    await act(async () => {
      runs = await current!.update(current!.targets);
    });
    expect(runs).toMatchObject([{ outcome: { status: "failed", message: "No catalog." } }]);
    expect(managedRuntimeRunOutcomes(runs)).toEqual([
      { status: "failed", line: "lab · Codex: No catalog." },
    ]);
  });
});

describe("managed runtime pass helpers", () => {
  it("counts a staged runtime as neither updated nor failed", () => {
    const target = {
      environmentId: lab,
      environmentLabel: "lab",
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      availableVersion: "0.157.1",
    };
    const run = (outcome: { status: "pending" } | { status: "succeeded"; version: string }) => ({
      target,
      operationId: "op",
      observed: true,
      outcome,
      waitingMessage: null,
    });
    expect(
      managedRuntimeRunOutcomes([
        run({ status: "pending" }),
        run({ status: "succeeded", version: "1" }),
      ]),
    ).toEqual([{ status: "updated" }]);
    expect(
      managedRuntimeProviderMachines([
        target,
        { ...target, driver: ProviderDriverKind.make("omp") },
      ]),
    ).toMatchObject([
      { environmentId: lab, label: "lab", providers: ["Codex", expect.any(String)] },
    ]);
  });

  it("reads only connected machines", () => {
    expect(
      connectedProviderEnvironments([
        {
          environmentId: lab,
          label: "lab",
          connection: { phase: "connected" },
          serverConfig: { providers: [] },
        },
        {
          environmentId: EnvironmentId.make("away"),
          label: "away",
          connection: { phase: "offline" },
          serverConfig: { providers: [] },
        },
      ]),
    ).toEqual([{ environmentId: lab, label: "lab", providers: [] }]);
  });
});
