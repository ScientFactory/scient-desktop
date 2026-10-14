import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { runUpdateEverything } from "~/components/sidebar/updateEverything.logic";

import {
  collectProviderUpdateMachines,
  describeProviderUpdateItem,
  getProviderUpdateResultsToastView,
  runProviderUpdates,
  systemProviderUpdateOutcome,
  type ProviderUpdateEnvironment,
  type ProviderUpdateItem,
  type ProviderUpdateOutcome,
} from "./providerUpdateInventory";

const checkedAt = "2026-10-14T10:00:00.000Z";

/** A provider whose system install is behind, optionally with a Scient-managed runtime. */
function provider(input: {
  readonly driver: string;
  readonly instanceId?: string;
  readonly enabled?: boolean;
  readonly version?: string;
  readonly latestVersion?: string;
  readonly updateCommand?: string | null;
  readonly updateState?: ServerProvider["updateState"];
  readonly managed?: {
    readonly source: "scient_managed" | "system";
    readonly installed: string;
    readonly available: string;
  };
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId ?? input.driver),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: input.version ?? "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.managed
      ? {
          connection: {
            methods: [],
            canDisconnect: false,
            operation: null,
            runtime: {
              source: input.managed.source,
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: ["update", "repair", "remove"],
              managedVersion: input.managed.installed,
              availableManagedVersion: input.managed.available,
              previousManagedVersion: null,
              operation: null,
              message: "Runtime ready.",
            },
          },
        }
      : {}),
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: input.version ?? "1.0.0",
      latestVersion: input.latestVersion ?? "1.1.0",
      updateCommand:
        input.updateCommand === undefined ? "npm install -g provider" : input.updateCommand,
      canUpdate: input.updateCommand !== null,
      checkedAt,
      message: "Update available.",
    },
    ...(input.updateState ? { updateState: input.updateState } : {}),
  };
}

const machine = (
  label: string,
  providers: ReadonlyArray<ServerProvider>,
  connected = true,
): ProviderUpdateEnvironment => ({
  environmentId: EnvironmentId.make(label),
  label,
  connected,
  providers,
});

const managedCodex = (instanceId: string) =>
  provider({
    driver: "codex",
    instanceId,
    managed: { source: "scient_managed", installed: "0.48.0", available: "0.50.1" },
  });

describe("collectProviderUpdateMachines", () => {
  const machines = collectProviderUpdateMachines([
    machine("alvin", [
      // Two instances share one managed runtime: one item.
      managedCodex("codex"),
      managedCodex("codex_work"),
      provider({ driver: "claudeAgent", version: "2.1.3", latestVersion: "2.2.0" }),
      // A custom path with no update command stays with its owner.
      provider({ driver: "cursor", updateCommand: null }),
      // Turned off.
      provider({ driver: "grok", enabled: false }),
      // A system runtime standing in for Scient's copy: Scient updates it, once.
      provider({
        driver: "droid",
        managed: { source: "system", installed: "0.235.0", available: "0.241.1" },
      }),
    ]),
    machine("offline", [provider({ driver: "claudeAgent" })], false),
  ]);

  it("lists each runtime once per connected machine, with the owner that updates it", () => {
    expect(machines).toHaveLength(1);
    expect(machines[0]!.items.map(describeProviderUpdateItem)).toEqual([
      "Codex 0.48.0 → 0.50.1 · managed by Scient",
      "Droid 0.235.0 → 0.241.1 · managed by Scient",
      "Claude 2.1.3 → 2.2.0 · system install",
    ]);
  });
});

const item = (driver: string, kind: ProviderUpdateItem["kind"], label = "alvin") => ({
  kind,
  environmentId: EnvironmentId.make(label),
  machineLabel: label,
  driver: ProviderDriverKind.make(driver),
  instanceId: ProviderInstanceId.make(driver),
  installedVersion: "1.0.0",
  offeredVersion: "1.1.0",
});

/** A promise and the function that settles it. */
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("runProviderUpdates", () => {
  it("starts managed updates in turn, waits for each to finish, and keeps every result", async () => {
    const codex = deferred<ProviderUpdateOutcome>();
    const droid = deferred<ProviderUpdateOutcome>();
    const events: Array<string> = [];
    const run = runProviderUpdates(
      [
        {
          environmentId: EnvironmentId.make("alvin"),
          label: "alvin",
          items: [
            item("codex", "managed"),
            item("droid", "managed"),
            item("claudeAgent", "system"),
            item("pi", "managed"),
          ],
        },
      ],
      {
        updateSystem: async (system) => {
          events.push(`system ${system.driver}`);
          return { status: "failed", message: "npm exited with code 1." };
        },
        startManaged: async (managed) => {
          events.push(`start ${managed.driver}`);
          if (managed.driver === "pi") throw new Error("Pi is busy.");
          return { finished: managed.driver === "codex" ? codex.promise : droid.promise };
        },
      },
    );
    // Starting the second does not wait for the first to finish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["system claudeAgent", "start codex", "start droid", "start pi"]);

    let settled = false;
    void run.then(() => {
      settled = true;
    });
    codex.resolve({ status: "succeeded", version: "1.1.0" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    droid.resolve({ status: "cancelled" });

    const results = await run;
    expect(results.map(({ item: { driver }, outcome }) => [driver, outcome.status])).toEqual([
      ["claudeAgent", "failed"],
      ["codex", "succeeded"],
      ["droid", "cancelled"],
      ["pi", "failed"],
    ]);
    expect(getProviderUpdateResultsToastView(results)).toEqual({
      type: "error",
      title: "2 of 4 provider updates failed",
      description: [
        "alvin · Claude: npm exited with code 1.",
        "alvin · Droid: Cancelled.",
        "alvin · Pi: Pi is busy.",
      ].join("\n"),
    });
  });

  it("installs this app only after every managed runtime is active", async () => {
    const codex = deferred<ProviderUpdateOutcome>();
    const events: Array<string> = [];
    const pass = runUpdateEverything({
      downloadLocal: async () => true,
      updateProviders: async () => {
        await runProviderUpdates(
          [
            {
              environmentId: EnvironmentId.make("alvin"),
              label: "alvin",
              items: [item("codex", "managed")],
            },
          ],
          {
            updateSystem: async () => ({ status: "succeeded", version: null }),
            startManaged: async () => ({ finished: codex.promise }),
          },
        );
        events.push("providers done");
      },
      updateServers: async () => {
        events.push("servers");
      },
      installLocal: async () => {
        events.push("install app");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
    codex.resolve({ status: "succeeded", version: "1.1.0" });
    await pass;
    expect(events).toEqual(["providers done", "servers", "install app"]);
  });
});

describe("getProviderUpdateResultsToastView", () => {
  it("reports success, cancellation alone, and nothing for interrupted requests", () => {
    expect(
      getProviderUpdateResultsToastView([
        { item: item("codex", "managed"), outcome: { status: "succeeded", version: "1.1.0" } },
        { item: item("claudeAgent", "system"), outcome: { status: "succeeded", version: null } },
      ]),
    ).toMatchObject({ type: "success", title: "2 providers updated" });
    expect(
      getProviderUpdateResultsToastView([
        { item: item("codex", "managed"), outcome: { status: "cancelled" } },
      ]),
    ).toEqual({
      type: "warning",
      title: "Provider update cancelled",
      description: "alvin · Codex: Cancelled.",
    });
    expect(
      getProviderUpdateResultsToastView([
        { item: item("codex", "system"), outcome: { status: "interrupted" } },
      ]),
    ).toBeNull();
  });
});

describe("systemProviderUpdateOutcome", () => {
  const claude = item("claudeAgent", "system");
  it("counts a system update as done only when the server verified it", () => {
    const answer = (status: "succeeded" | "unchanged", message: string | null) =>
      systemProviderUpdateOutcome(
        claude,
        AsyncResult.success({
          providers: [
            provider({
              driver: "claudeAgent",
              version: "2.2.0",
              updateState: {
                status,
                startedAt: checkedAt,
                finishedAt: checkedAt,
                message,
                output: null,
              },
            }),
          ],
        }),
      );
    expect(answer("succeeded", null)).toEqual({ status: "succeeded", version: "2.2.0" });
    expect(answer("unchanged", "Still 2.1.3 after the update.")).toEqual({
      status: "failed",
      message: "Still 2.1.3 after the update.",
    });
  });
});
