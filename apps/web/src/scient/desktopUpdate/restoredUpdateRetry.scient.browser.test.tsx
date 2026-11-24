import { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "~/components/ServerUpdateAction";
import type {
  UpdateEverythingMachine,
  UpdateEverythingRun,
} from "~/components/sidebar/updateEverything.logic";
import type { OtherServerUpdate } from "./otherUpdates.logic";

const testState = vi.hoisted(() => ({
  lab: "lab" as EnvironmentId,
  readRegistry: (): AtomRegistry.AtomRegistry | undefined => undefined,
  configs: new Map<string, Atom.Writable<unknown>>(),
  run: null as UpdateEverythingRun | null,
  qualified: [] as ReadonlyArray<ServerUpdateTarget>,
  updateServer:
    vi.fn<(target: ServerUpdateTarget, options: unknown) => Promise<ServerUpdateOutcome>>(),
}));

function configAtom(id: string): Atom.Writable<unknown> {
  let atom = testState.configs.get(id);
  if (!atom) {
    // Kept alive like the app's config atom, which the connection observes.
    atom = Atom.make<unknown>(null).pipe(Atom.keepAlive);
    testState.configs.set(id, atom);
  }
  return atom;
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => testState.readRegistry()!.get(atom),
    set: <R, W>(atom: Atom.Writable<R, W>, value: W) => testState.readRegistry()!.set(atom, value),
    update: <R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W) =>
      testState.readRegistry()!.update(atom, f),
    mount: () => () => {},
    subscribe: () => () => {},
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: testState.lab,
        label: "lab-gpu",
        connection: { phase: "connected" },
        entry: { target: { _tag: "BearerConnectionTarget" } },
        serverConfig: { providers: [] },
      },
    ],
  }),
  useEnvironmentProviders: () => new Map([[testState.lab, []]]),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateProvider: Symbol("update-provider"),
    providersValueAtom: () => Atom.make([]),
    updateStateAtom: () => Atom.make({ status: "idle" }),
    settingsValueAtom: () => Atom.make(null),
    configValueAtom: (id: string) => configAtom(id),
  },
}));
// The pass's run store, settling a machine as the app does.
vi.mock("~/components/sidebar/updateEverythingRun", async () => {
  const { closeFinishedUpdateRun } = await import("~/components/sidebar/updateEverything.logic");
  const setUpdateEverythingRun = (
    update: (run: UpdateEverythingRun | null) => UpdateEverythingRun | null,
  ) => {
    testState.run = update(testState.run);
  };
  return {
    useUpdateEverythingRun: () => testState.run,
    useQualifiedUpdateRunServers: () => testState.qualified,
    setUpdateEverythingRun,
    settleUpdateRunMachine: (
      environmentId: EnvironmentId,
      failure: string | null,
      { serverUpdated = false }: { readonly serverUpdated?: boolean } = {},
    ) =>
      setUpdateEverythingRun(
        (run) =>
          run &&
          closeFinishedUpdateRun({
            ...run,
            machines: run.machines.map((machine) =>
              machine.environmentId === environmentId
                ? {
                    ...machine,
                    result: failure === null ? "done" : "failed",
                    failure,
                    ...(serverUpdated ? { server: null } : {}),
                  }
                : machine,
            ),
          }),
      ),
  };
});
// Only the footer placement uses the sidebar's menu item, which reads app settings.
vi.mock("~/components/ui/sidebar", () => ({ SidebarMenuItem: () => null }));
vi.mock("~/components/ui/toast", () => ({
  hiddenToastActionProps: { children: null },
  stackedThreadToast: (options: object) => options,
  toastManager: { add: () => "toast" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/components/ServerUpdateAction", () => ({
  useServerUpdate: () => testState.updateServer,
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { environmentThreadsAtom: () => Atom.make([]) },
}));
vi.mock("~/scient/providerConnection/useManagedRuntimeUpdates", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/scient/providerConnection/useManagedRuntimeUpdates")
  >()),
  useManagedRuntimeUpdates: () => ({
    candidates: [],
    targets: [],
    runs: new Map(),
    update: vi.fn(),
  }),
}));
vi.mock("~/scient/providerConnection/environmentUpdateWatch", () => ({
  watchEnvironmentProviders: vi.fn(),
}));
vi.mock("~/scient/providerConnection/useProviderLifecycleController", () => ({
  useStartProviderRuntimeAction: vi.fn(),
}));

const { AtomRegistry: Registry } = await import("effect/reactivity");
const { SidebarOtherUpdates } = await import("./SidebarOtherUpdates");

const lab = testState.lab;
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

type Mechanism = NonNullable<ServerUpdateTarget["selfUpdate"]>;

function environment(serverVersion: string, selfUpdate: Mechanism = "boot-service") {
  return {
    environmentId: lab,
    label: "lab-gpu",
    platform: { os: "linux" as const, arch: "x64" as const },
    serverVersion,
    capabilities: { repositoryIdentity: true, serverSelfUpdate: selfUpdate },
  };
}

/** The server as this app sees it: connected and behind the version the pass handed it. */
function currentServers(selfUpdate: Mechanism): ReadonlyArray<UpdateEverythingMachine> {
  return [
    {
      environmentId: lab,
      label: "lab-gpu",
      serverConfig: {
        environment: environment("0.6.20", selfUpdate),
        settings: { continueThreadsAfterServerUpdate: false },
      },
      connected: true,
      hostedByThisApp: false,
      canMaintain: true,
      updateState: { status: "idle" },
    },
  ];
}

/**
 * The row a relaunched app rebuilds from its saved handoff: the version and the mechanism the
 * user confirmed, no target. `null` is a record saved before Scient kept the mechanism.
 */
function restoredRun(confirmed: Mechanism | null): UpdateEverythingRun {
  return {
    localVersion: null,
    phase: "servers",
    restartAt: null,
    machines: [
      {
        environmentId: lab,
        label: "lab-gpu",
        updatesProviders: false,
        server: null,
        handedOffVersion: "0.6.21",
        ...(confirmed === null ? {} : { handedOffSelfUpdate: confirmed }),
        startedAt: 0,
        result: "failed",
        failure: "Not back after 10 minutes",
        providerFailure: null,
      },
    ],
  };
}

/** Renders the circle after a relaunch, with the server now offering `offered`. */
async function renderRestored({
  confirmed = "boot-service",
  offered = "boot-service",
}: { readonly confirmed?: Mechanism | null; readonly offered?: Mechanism } = {}) {
  const registry = Registry.make();
  testState.readRegistry = () => registry;
  testState.configs = new Map();
  testState.updateServer.mockReset().mockResolvedValue({ status: "updated" } as never);
  const target = { ...serverTarget, selfUpdate: offered };
  testState.qualified = [target];
  testState.run = restoredRun(confirmed);
  registry.set(configAtom(lab), { environment: environment("0.6.20", offered) });
  const screen = await render(
    <SidebarOtherUpdates
      current={currentServers(offered)}
      servers={[{ ...serverUpdate, target }]}
      updateAll={vi.fn()}
    />,
  );
  return {
    screen,
    registry,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      registry.dispose();
      testState.readRegistry = () => undefined;
    },
  };
}

async function renderRestoredFailure() {
  const fixture = await renderRestored();
  await fixture.screen.getByRole("button", { name: "Other update failed", exact: true }).click();
  await expect.element(page.getByText("Not back after 10 minutes")).toBeVisible();
  return fixture;
}

/** The row offers the ordinary Update, which asks again, and no Retry that would skip that. */
async function expectFreshUpdateOnly(fixture: Awaited<ReturnType<typeof renderRestored>>) {
  // Opens the circle in whatever state it shows; a kept failure would label it "failed".
  await fixture.screen.getByRole("button", { name: /^Other update/ }).click();
  await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Retry", exact: true }))
    .not.toBeInTheDocument();
  expect(testState.updateServer).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Other updates available", exact: true }))
    .toBeVisible();
}

it("retries a failed server update restored after this app relaunched", async () => {
  await using _ = await renderRestoredFailure();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  // The retry sends the confirmed version and mechanism, rebuilt from the server as it is now.
  expect(testState.updateServer).toHaveBeenCalledExactlyOnceWith(serverTarget, { quiet: false });
  await vi.waitFor(() => expect(testState.run).toBeNull());
});

it("settles a restored server already on its target without updating it", async () => {
  await using fixture = await renderRestoredFailure();
  // The server comes back on the target version before Retry is pressed.
  fixture.registry.set(configAtom(lab), { environment: environment("0.6.21") });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect(testState.updateServer).not.toHaveBeenCalled();
  expect(testState.run).toBeNull();
});

it("offers a fresh Update, not Retry, when the same server and version now use another mechanism", async () => {
  // The user confirmed a service update; the server now offers its own app's update instead.
  await using fixture = await renderRestored({ confirmed: "boot-service", offered: "respawn" });
  await expectFreshUpdateOnly(fixture);
});

it("offers a fresh Update, not Retry, for a row saved without its mechanism", async () => {
  await using fixture = await renderRestored({ confirmed: null });
  await expectFreshUpdateOnly(fixture);
});
