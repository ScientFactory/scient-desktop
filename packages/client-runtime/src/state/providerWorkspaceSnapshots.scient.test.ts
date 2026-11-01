import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  recordFetchedWorkspaceInventory,
  recordFetchedWorkspaceSnapshot,
  withFetchedWorkspaceSnapshots,
} from "./providerWorkspaceSnapshots.ts";
import {
  INVENTORY_PROVIDER,
  OTHER_INVENTORY_PROVIDER,
  inventoryConfig,
  inventoryProvider,
  inventorySnapshot,
} from "./providerWorkspaceSnapshots.scient.fixture.ts";

it("keeps the composer cache bounded while leaving full inventory replies complete", () => {
  const providers: ServerProvider[] = Array.from({ length: 3 }, (_, instance) => ({
    instanceId: ProviderInstanceId.make(`provider-${instance}`),
    driver: ProviderDriverKind.make("codex"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-26T00:00:00.000Z",
    version: null,
    models: [],
    skills: [],
    slashCommands: [],
    workspaceSnapshots: Array.from({ length: 16 }, (_, cwd) => ({
      cwd: `/project-${instance}-${cwd}`,
      checkedAt: "2026-10-26T00:00:00.000Z",
      skills: [],
      slashCommands: [],
      plugins: [{ id: "plugin", name: "Plugin", enabled: true, source: "local" as const }],
    })),
  }));
  const fetched = recordFetchedWorkspaceInventory([], providers, providers);
  expect(fetched).toHaveLength(32);
  expect(providers.flatMap((provider) => provider.workspaceSnapshots ?? [])).toHaveLength(48);
  expect(fetched.at(-1)?.snapshot.plugins?.[0]?.id).toBe("plugin");
  expect(recordFetchedWorkspaceInventory(fetched, providers, providers)).toBe(fetched);

  const config = {
    environment: { capabilities: { providerWorkspaceSnapshotsOnDemand: false } },
    providers,
  } as unknown as ServerConfig;
  expect(withFetchedWorkspaceSnapshots(config, fetched)).toBe(config);
  expect(
    recordFetchedWorkspaceInventory(
      fetched,
      providers.map((provider) => ({ ...provider, workspaceSnapshots: [] })),
      providers,
    ),
  ).toEqual([]);
});

it("drops cached A inventory on a same-ID B replacement with identical machine fields", () => {
  const a = inventoryProvider("A", [inventorySnapshot("/project", "old")]);
  const b = inventoryProvider("B");
  const fetched = recordFetchedWorkspaceInventory([], [a], [a]);
  expect(
    withFetchedWorkspaceSnapshots(inventoryConfig([a]), fetched).providers[0]?.workspaceSnapshots,
  ).toEqual(a.workspaceSnapshots);
  expect(
    withFetchedWorkspaceSnapshots(inventoryConfig([b]), fetched).providers[0]?.workspaceSnapshots,
  ).toEqual([]);
});

it.each(["full", "cwd"] as const)("keeps the %s reply's machine provenance", (path) => {
  const reply = inventoryProvider("B", [inventorySnapshot("/project", "reply")]);
  const current = { ...inventoryProvider("B"), slashCommands: [{ name: "new-machine-command" }] };
  const fetched =
    path === "full"
      ? recordFetchedWorkspaceInventory([], [reply], [current])
      : recordFetchedWorkspaceSnapshot(
          [],
          { instanceId: INVENTORY_PROVIDER, cwd: "/project", fresh: false },
          [reply],
          current,
        );
  expect(fetched).toHaveLength(1);
  expect(
    withFetchedWorkspaceSnapshots(inventoryConfig([current]), fetched).providers[0]
      ?.workspaceSnapshots,
  ).toEqual([]);
  expect(
    withFetchedWorkspaceSnapshots(inventoryConfig([reply]), fetched).providers[0]
      ?.workspaceSnapshots,
  ).toEqual(reply.workspaceSnapshots);
});

it.each([
  ["A", "B"],
  [undefined, "B"],
  ["A", undefined],
] as const)(
  "refuses generation %s against %s before either writer can clear entries",
  (replyGeneration, currentGeneration) => {
    const currentProvider = inventoryProvider(currentGeneration, [
      inventorySnapshot("/project", "current"),
    ]);
    const other = inventoryProvider(
      "other",
      [inventorySnapshot("/project", "other")],
      OTHER_INVENTORY_PROVIDER,
    );
    const providers = [currentProvider, other];
    const fetched = recordFetchedWorkspaceInventory([], providers, providers);
    const reply = inventoryProvider(replyGeneration, [inventorySnapshot("/project", "retired")]);
    expect(recordFetchedWorkspaceInventory(fetched, [reply, other], providers)).toBe(fetched);
    expect(
      recordFetchedWorkspaceSnapshot(
        fetched,
        { instanceId: INVENTORY_PROVIDER, cwd: "/project", fresh: true },
        [reply],
        currentProvider,
      ),
    ).toBe(fetched);
  },
);

it("rejects full replies missing a current generation or still containing a removed one", () => {
  const b = inventoryProvider("B", [inventorySnapshot("/project", "current")]);
  const other = inventoryProvider(
    "other",
    [inventorySnapshot("/project", "other")],
    OTHER_INVENTORY_PROVIDER,
  );
  const fetched = recordFetchedWorkspaceInventory([], [b, other], [b, other]);
  expect(recordFetchedWorkspaceInventory(fetched, [b], [b, other])).toBe(fetched);
  expect(recordFetchedWorkspaceInventory(fetched, [b, other], [b])).toBe(fetched);
  expect(
    recordFetchedWorkspaceSnapshot(
      fetched,
      { instanceId: INVENTORY_PROVIDER, cwd: "/project", fresh: true },
      [],
      b,
    ),
  ).toBe(fetched);
});

it.each(["B", undefined])(
  "keeps admitted empty, removal and fresh semantics for generation %s",
  (generation) => {
    const primary = inventoryProvider(generation, [
      inventorySnapshot("/project", "primary"),
      inventorySnapshot("/untouched", "untouched"),
    ]);
    const other = inventoryProvider(
      generation,
      [inventorySnapshot("/project", "other")],
      OTHER_INVENTORY_PROVIDER,
    );
    const providers = [primary, other];
    const fetched = recordFetchedWorkspaceInventory([], providers, providers);
    const input = { instanceId: INVENTORY_PROVIDER, cwd: "/project", fresh: false };
    expect(recordFetchedWorkspaceSnapshot(fetched, input, providers, primary)).toBe(fetched);
    const empty = inventoryProvider(generation);
    expect(
      recordFetchedWorkspaceSnapshot(fetched, input, [empty], empty).map((entry) => entry.snapshot),
    ).toEqual([primary.workspaceSnapshots![1], other.workspaceSnapshots![0]]);
    expect(
      recordFetchedWorkspaceSnapshot(fetched, { ...input, fresh: true }, [empty], empty).map(
        (entry) => entry.snapshot,
      ),
    ).toEqual([primary.workspaceSnapshots![1]]);
    const replacement = inventoryProvider(generation, [
      inventorySnapshot("/project", "replacement"),
    ]);
    expect(
      recordFetchedWorkspaceSnapshot(
        fetched,
        { ...input, fresh: true },
        [replacement],
        replacement,
      ).map((entry) => entry.snapshot),
    ).toEqual([primary.workspaceSnapshots![1], replacement.workspaceSnapshots![0]]);
    expect(
      recordFetchedWorkspaceInventory(
        fetched,
        [empty, inventoryProvider(generation, [], OTHER_INVENTORY_PROVIDER)],
        providers,
      ),
    ).toEqual([]);
    expect(
      recordFetchedWorkspaceInventory(fetched, [primary], [primary]).map(
        (entry) => entry.instanceId,
      ),
    ).toEqual([INVENTORY_PROVIDER, INVENTORY_PROVIDER]);
    expect(recordFetchedWorkspaceInventory(fetched, [], [])).toEqual([]);
    if (generation === undefined) {
      expect(
        recordFetchedWorkspaceSnapshot(fetched, { ...input, fresh: true }, [], empty).map(
          (entry) => entry.snapshot,
        ),
      ).toEqual([primary.workspaceSnapshots![1]]);
    }
  },
);

it("bounds repeated admitted cwd writes to 32 entries", () => {
  let fetched: Parameters<typeof recordFetchedWorkspaceSnapshot>[0] = [];
  for (let index = 0; index < 40; index++) {
    const cwd = `/project-${index}`;
    const provider = inventoryProvider("B", [inventorySnapshot(cwd, `command-${index}`)]);
    fetched = recordFetchedWorkspaceSnapshot(
      fetched,
      { instanceId: INVENTORY_PROVIDER, cwd, fresh: false },
      [provider],
      provider,
    );
  }
  expect(fetched).toHaveLength(32);
  expect(fetched[0]?.snapshot.cwd).toBe("/project-8");
  expect(fetched.at(-1)?.snapshot.cwd).toBe("/project-39");
});
