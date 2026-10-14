import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runUpdateEverything } from "~/components/sidebar/updateEverything.logic";

import {
  waitForManagedRuntimesIdle,
  watchManagedRuntimeUpdate,
  type LiveProviderEnvironment,
  type ProviderSnapshotSource,
} from "./managedRuntimeUpdateWatch";
import { runProviderUpdates, type ProviderUpdateItem } from "./providerUpdateInventory";

const alvin = EnvironmentId.make("alvin");
const checkedAt = "2026-10-14T10:00:00.000Z";

const operation = (status: ProviderRuntimeOperation["status"]): ProviderRuntimeOperation => ({
  operationId: "op-1",
  action: "update",
  status,
  startedAt: checkedAt,
  finishedAt: status === "succeeded" || status === "failed" ? checkedAt : null,
  message: status === "failed" ? "The download did not verify." : "Updating.",
});

function codex(input: {
  readonly version: string;
  readonly operation: ProviderRuntimeOperation | null;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: input.version,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: [],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: input.version,
        previousManagedVersion: null,
        operation: input.operation,
        message: "Runtime ready.",
      },
    },
  };
}

/** A snapshot source the test advances by hand. */
function snapshots(initial: LiveProviderEnvironment) {
  let current = [initial];
  const listeners = new Set<() => void>();
  const source: ProviderSnapshotSource = {
    read: () => current,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    source,
    listeners,
    publish: (next: LiveProviderEnvironment) => {
      current = [next];
      for (const listener of [...listeners]) listener();
    },
  };
}

const environment = (
  provider: ServerProvider,
  connection: LiveProviderEnvironment["connection"] = "connected",
): LiveProviderEnvironment => ({ environmentId: alvin, connection, providers: [provider] });

const item: ProviderUpdateItem = {
  kind: "managed",
  environmentId: alvin,
  machineLabel: "alvin",
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
  installedVersion: "0.48.0",
  offeredVersion: "0.50.1",
};

const settledSoon = <A>(promise: Promise<A>) =>
  Promise.race([
    promise,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
  ]);

describe("watchManagedRuntimeUpdate", () => {
  it("follows the update to its active runtime and then stops listening", async () => {
    const live = snapshots(
      environment(codex({ version: "0.48.0", operation: operation("activating") })),
    );
    const result = watchManagedRuntimeUpdate(live.source, item, "op-1");
    expect(await settledSoon(result)).toBe("pending");
    live.publish(environment(codex({ version: "0.50.1", operation: operation("succeeded") })));
    expect(await result).toEqual({ status: "succeeded", version: "0.50.1" });
    expect(live.listeners.size).toBe(0);
  });

  it("waits through a reconnect, never settling on its cached snapshot", async () => {
    const live = snapshots(
      environment(codex({ version: "0.48.0", operation: operation("activating") })),
    );
    const result = watchManagedRuntimeUpdate(live.source, item, "op-1");
    live.publish(
      environment(codex({ version: "0.48.0", operation: operation("failed") }), "reconnecting"),
    );
    expect(await settledSoon(result)).toBe("pending");
    live.publish(environment(codex({ version: "0.50.1", operation: operation("succeeded") })));
    expect(await result).toEqual({ status: "succeeded", version: "0.50.1" });
  });

  it("fails when the environment is lost", async () => {
    const live = snapshots(
      environment(codex({ version: "0.48.0", operation: operation("activating") })),
    );
    const result = watchManagedRuntimeUpdate(live.source, item, "op-1");
    live.publish(
      environment(codex({ version: "0.48.0", operation: operation("activating") }), "lost"),
    );
    expect(await result).toMatchObject({ status: "failed" });
  });

  it("counts an update that finished before it was ever seen", async () => {
    const live = snapshots(environment(codex({ version: "0.50.1", operation: null })));
    expect(await watchManagedRuntimeUpdate(live.source, item, "op-1")).toEqual({
      status: "succeeded",
      version: "0.50.1",
    });
  });
});

describe("waitForManagedRuntimesIdle", () => {
  it("installs this app only after every managed operation ends, even one this pass did not start", async () => {
    // Another managed update holds the runtime, so this pass's start fails.
    const live = snapshots(
      environment(codex({ version: "0.48.0", operation: operation("activating") })),
    );
    const events: Array<string> = [];
    const pass = runUpdateEverything({
      updateProviders: async () => {
        const results = await runProviderUpdates(
          [{ environmentId: alvin, label: "alvin", items: [item] }],
          {
            updateSystem: async () => ({ status: "succeeded", version: null }),
            startManaged: async () => {
              throw new Error("Codex is already updating.");
            },
          },
        );
        events.push(`providers ${results[0]!.outcome.status}`);
        await waitForManagedRuntimesIdle(live.source);
      },
      updateServers: async () => {
        events.push("servers");
      },
      installLocal: async () => {
        events.push("install app");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["providers failed"]);
    live.publish(environment(codex({ version: "0.50.1", operation: operation("succeeded") })));
    await pass;
    expect(events).toEqual(["providers failed", "servers", "install app"]);
  });
});
