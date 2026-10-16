import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  type AuthSessionState,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import type { UpdateEverythingMachine, UpdateRunMachine } from "./updateEverything.logic";

type TestEnvironment = {
  environmentId: EnvironmentId;
  label: string;
  serverConfig: NonNullable<UpdateEverythingMachine["serverConfig"]>;
  connection: { phase: "connected" | "offline" };
  entry: { target: { _tag: "SshConnectionTarget" } };
};

const testState = vi.hoisted(() => ({
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  environments: [] as TestEnvironment[],
  sessions: new Map<string, Atom.Writable<AsyncResult.AsyncResult<AuthSessionState, never>>>(),
  updateStateAtom: undefined as Atom.Atom<{ status: "idle" }> | undefined,
  availability: undefined as AsyncResult.AsyncResult<boolean, string> | undefined,
  updateProviders: vi.fn<() => Promise<ReadonlyArray<never>>>(),
  settleMachine:
    vi.fn<
      (
        environmentId: string,
        failure: string | null,
        options?: { readonly serverUpdated?: boolean; readonly providerFailure?: string | null },
      ) => void
    >(),
  // The real run module, so a Retry runs against what the hook last published.
  runModule: undefined as typeof import("./updateEverythingRun") | undefined,
  showResult: vi.fn<(result: { readonly failures: ReadonlyArray<string> }) => void>(),
  updateServer:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { targetVersion: string; continueRunningThreads?: boolean };
      }) => Promise<AsyncResult.AsyncResult<{ targetVersion: string }, never>>
    >(),
}));

vi.mock("~/branding", () => ({ APP_VERSION: "0.6.2" }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: (id: string) => testState.sessions.get(id)! },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.registry!.get(atom),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.registry!.update(atom, f),
  },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateStateAtom: () => testState.updateStateAtom!,
    updateServer: Symbol("update-server"),
  },
  updateOutdatedServer: Symbol("update-outdated-server"),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => false }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ useCopyToClipboard: () => ({}) }));
vi.mock("../ProviderUpdatesAction", () => ({
  useProviderUpdates: () => ({ machines: [], updateAll: testState.updateProviders }),
}));
vi.mock("~/scient/desktopUpdate/serverReleaseAvailability", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/scient/desktopUpdate/serverReleaseAvailability")>();
  return {
    ...original,
    useScientServerReleasePublished: () =>
      original.isCurrentScientServerReleasePublished(testState.availability!),
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./updateEverythingRun", async (importOriginal) => {
  const original = await importOriginal<typeof import("./updateEverythingRun")>();
  testState.runModule = original;
  return {
    setUpdateEverythingRun: () => {},
    settleUpdateRunMachine: testState.settleMachine,
    showUpdateEverythingResult: testState.showResult,
    saveUpdateEverythingResult: () => {},
    clearSavedUpdateEverythingResult: () => {},
    // No server restarts into its update here, so each hands off when its update finishes.
    waitForServerUpdateHandoff: (_environmentId: EnvironmentId, finished: Promise<unknown>) =>
      finished.then(
        () => {},
        () => {},
      ),
    waitForUpdateRestart: async () => false,
    publishQualifiedUpdateRunServers: original.publishQualifiedUpdateRunServers,
  };
});

import { useUpdateEverything } from "./useUpdateEverything";

const session: AuthSessionState = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  },
};

function environment(id: string, selfUpdate: ServerSelfUpdateCapability): TestEnvironment {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.6.1",
        capabilities: {
          repositoryIdentity: true,
          serverSelfUpdate: selfUpdate,
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
          threadRestartContinuation: true,
          serverUpdateThreadContinuation: true,
        },
      },
      settings: { continueThreadsAfterServerUpdate: true },
    },
    connection: { phase: "connected" },
    entry: { target: { _tag: "SshConnectionTarget" } },
  };
}

let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useUpdateEverything> | undefined;
function Probe({ version = null }: { version?: string | null }) {
  const value = useUpdateEverything(version);
  useLayoutEffect(() => {
    current = value;
  });
  return null;
}

beforeEach(() => {
  testState.registry = AtomRegistry.make();
  testState.environments = [
    environment("service", "boot-service"),
    environment("desktop", "desktop-managed"),
  ];
  testState.sessions = new Map(
    ["service", "desktop", "new-machine"].map(
      (id) =>
        [
          id,
          Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.success(session)),
        ] as const,
    ),
  );
  testState.updateStateAtom = Atom.make({ status: "idle" as const });
  testState.availability = AsyncResult.success(true);
  testState.updateProviders.mockReset().mockResolvedValue([]);
  testState.settleMachine.mockReset();
  testState.showResult.mockReset();
  testState.updateServer
    .mockReset()
    .mockImplementation(async ({ input }) =>
      AsyncResult.success({ targetVersion: input.targetVersion }),
    );
  current = undefined;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  testState.registry?.dispose();
});

async function holdPass() {
  let finishProviders = () => {};
  testState.updateProviders.mockImplementationOnce(
    () =>
      new Promise<ReadonlyArray<never>>((resolve) => {
        finishProviders = () => resolve([]);
      }),
  );
  await act(() => {
    renderer = create(<Probe />);
  });
  let run: Promise<void> | undefined;
  await act(() => {
    run = current!.run({});
  });
  expect(testState.updateProviders).toHaveBeenCalledOnce();
  expect(testState.updateServer).not.toHaveBeenCalled();
  return {
    finish: async () =>
      act(async () => {
        finishProviders();
        await run;
      }),
  };
}

it.each(["failure", "refresh"] as const)(
  "withdraws a held exact-service target on current %s, preserving remote desktop and recovery",
  async (phase) => {
    const pass = await holdPass();
    const previous = AsyncResult.success(true);
    testState.availability =
      phase === "failure"
        ? AsyncResult.failureWithPrevious(Cause.fail("403"), { previous: Option.some(previous) })
        : AsyncResult.waiting(previous);
    // The still-eligible desktop's current flags, not the original confirmed flags, drive dispatch.
    testState.environments = testState.environments.map((entry) =>
      entry.environmentId === "desktop"
        ? {
            ...entry,
            serverConfig: {
              ...entry.serverConfig,
              settings: { continueThreadsAfterServerUpdate: false },
            },
          }
        : entry,
    );
    await act(() => renderer!.update(<Probe />));
    await pass.finish();
    expect(testState.updateServer.mock.calls).toMatchObject([
      [{ environmentId: "desktop", input: { targetVersion: "0.6.2" } }],
    ]);
    expect(testState.updateServer.mock.calls[0]![0].input).not.toHaveProperty(
      "continueRunningThreads",
    );

    testState.availability = AsyncResult.success(true);
    await act(() => renderer!.update(<Probe />));
    testState.updateServer.mockClear();
    await act(async () => {
      await current!.run({});
    });
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "service",
      "desktop",
    ]);
  },
);

it.each(["scope", "offline", "channel", "capability", "mechanism", "current"] as const)(
  "does not admit a changed %s target or a newly eligible machine into a confirmed pass",
  async (change) => {
    const pass = await holdPass();
    const first = testState.environments[0]!;
    if (change === "scope") {
      testState.registry!.set(
        testState.sessions.get("service")!,
        AsyncResult.success({ ...session, scopes: [] }),
      );
    }
    const capabilities = { ...first.serverConfig.environment.capabilities };
    if (change === "capability") delete capabilities.serverSelfUpdate;
    if (change === "mechanism") {
      capabilities.serverSelfUpdate = "desktop-managed";
      capabilities.desktopAppUpdate = true;
    }
    testState.environments = [
      {
        ...first,
        ...(change === "offline" ? { connection: { phase: "offline" as const } } : {}),
        serverConfig: {
          ...first.serverConfig,
          environment: {
            ...first.serverConfig.environment,
            capabilities,
            serverVersion:
              change === "channel"
                ? "0.6.1-beta.20261013.1"
                : change === "current"
                  ? "0.6.2"
                  : "0.6.1",
          },
        },
      },
      testState.environments[1]!,
      environment("new-machine", "boot-service"),
    ];
    await act(() => renderer!.update(<Probe />));
    await pass.finish();
    expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
      "desktop",
    ]);
  },
);

it("does not change the confirmed version during a held provider step", async () => {
  const pass = await holdPass();
  await act(() => renderer!.update(<Probe version="0.6.3" />));
  await pass.finish();
  expect(testState.updateServer).not.toHaveBeenCalled();
});

it("retires an unmounted held pass without disabling a newly confirmed pass", async () => {
  const pass = await holdPass();
  await act(() => renderer!.unmount());
  renderer = undefined;
  testState.availability = AsyncResult.failureWithPrevious(Cause.fail("403"), {
    previous: Option.some(AsyncResult.success(true)),
  });
  await act(() => {
    renderer = create(<Probe />);
  });
  await pass.finish();
  expect(testState.updateServer).not.toHaveBeenCalled();
  // The withdrawn servers settle and are named in the summary instead of waiting forever.
  const withdrawn = "Not updated; it was no longer eligible when servers updated.";
  expect(testState.settleMachine.mock.calls).toEqual([
    ["service", withdrawn, { providerFailure: null }],
    ["desktop", withdrawn, { providerFailure: null }],
  ]);
  expect(testState.showResult.mock.calls[0]?.[0].failures).toEqual([
    "service: Not updated; it was no longer eligible when servers updated.",
    "desktop: Not updated; it was no longer eligible when servers updated.",
  ]);

  testState.availability = AsyncResult.success(true);
  await act(() => renderer!.update(<Probe />));
  await act(async () => {
    await current!.run({});
  });
  expect(testState.updateServer.mock.calls.map(([request]) => request.environmentId)).toEqual([
    "service",
    "desktop",
  ]);
});

function failedRunMachine(target: ServerUpdateTarget): UpdateRunMachine {
  return {
    environmentId: target.environmentId,
    label: target.serverLabel,
    updatesProviders: false,
    server: target,
    handedOffVersion: null,
    startedAt: 0,
    result: "failed",
    failure: "Server update failed",
    providerFailure: null,
  };
}

it.each(["availability", "scope", "version", "mechanism", "owner"] as const)(
  "does not retry a failed server whose target lost its %s, and still retries an eligible one",
  async (change) => {
    const run = testState.runModule!;
    await act(() => {
      renderer = create(<Probe />);
    });
    // Confirmed with flags the eligible server no longer has.
    const confirmed = (id: string, selfUpdate: ServerSelfUpdateCapability): ServerUpdateTarget => ({
      environmentId: EnvironmentId.make(id),
      serverLabel: id,
      selfUpdate,
      continueThreadsAfterServerUpdate: false,
      targetVersion: "0.6.2",
    });
    const service = confirmed("service", "boot-service");
    const desktop = confirmed("desktop", "desktop-managed");
    const savedService =
      change === "version"
        ? { ...service, targetVersion: "0.6.3" }
        : change === "mechanism"
          ? { ...service, selfUpdate: "desktop-managed" as const }
          : service;
    run.setUpdateEverythingRun(() => ({
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [failedRunMachine(savedService), failedRunMachine(desktop)],
    }));
    if (change === "availability") {
      testState.availability = AsyncResult.failureWithPrevious(Cause.fail("403"), {
        previous: Option.some(AsyncResult.success(true)),
      });
    }
    if (change === "scope") {
      testState.registry!.set(
        testState.sessions.get("service")!,
        AsyncResult.success({ ...session, scopes: [] }),
      );
    }
    if (change === "owner") {
      await act(() => renderer!.unmount());
      renderer = undefined;
    } else {
      await act(() => renderer!.update(<Probe />));
    }

    const update = vi.fn<(target: ServerUpdateTarget) => Promise<ServerUpdateOutcome>>(
      async () => ({ status: "updated" }),
    );
    await act(async () => {
      run.retryFailedUpdateRunServers(update);
    });

    if (change === "owner") {
      expect(update).not.toHaveBeenCalled();
    } else {
      // The eligible retry keeps its confirmed version and mechanism, with current flags.
      expect(update.mock.calls).toEqual([
        [
          expect.objectContaining({
            environmentId: "desktop",
            selfUpdate: "desktop-managed",
            targetVersion: "0.6.2",
            continueThreadsAfterServerUpdate: true,
          }),
          { quiet: true },
        ],
      ]);
    }
    const machines = run.useUpdateEverythingRun()?.machines ?? [];
    expect(machines.find((machine) => machine.environmentId === "service")).toMatchObject({
      server: null,
      result: "failed",
      failure: "Not retried; it is no longer eligible for this update.",
    });
  },
);
