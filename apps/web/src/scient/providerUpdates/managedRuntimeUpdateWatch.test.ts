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
  liveConnection,
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

  it("reports lost contact when a reconnect outlasts its grace period", async () => {
    const live = snapshots(
      environment(codex({ version: "0.48.0", operation: operation("activating") }), "reconnecting"),
    );
    expect(
      await watchManagedRuntimeUpdate(live.source, item, "op-1", { reconnectGraceMs: 20 }),
    ).toMatchObject({ status: "failed" });
    expect(live.listeners.size).toBe(0);
  });

  it("reports while the new runtime waits for running work", async () => {
    const waitingFor = (waitingForIdle: boolean) =>
      environment(
        codex({
          version: "0.48.0",
          operation: { ...operation("activating"), waitingForIdle },
        }),
      );
    const live = snapshots(waitingFor(false));
    const changes: Array<boolean> = [];
    const result = watchManagedRuntimeUpdate(live.source, item, "op-1", {
      onWaitingChange: (waiting) => changes.push(waiting),
    });
    live.publish(waitingFor(true));
    live.publish(waitingFor(true));
    expect(changes).toEqual([true]);
    live.publish(environment(codex({ version: "0.50.1", operation: operation("succeeded") })));
    await result;
    expect(changes).toEqual([true, false]);
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

describe("liveConnection", () => {
  it("waits through offline and reconnects, and gives up only on a closed or failed connection", () => {
    expect(liveConnection("connected")).toBe("connected");
    expect(liveConnection("offline")).toBe("reconnecting");
    expect(liveConnection("connecting")).toBe("reconnecting");
    expect(liveConnection("reconnecting")).toBe("reconnecting");
    expect(liveConnection("available")).toBe("lost");
    expect(liveConnection("error")).toBe("lost");
    expect(liveConnection("unsupported")).toBe("lost");
  });
});

describe("waitForManagedRuntimesIdle", () => {
  it("treats a reconnecting machine's last known update as still running", async () => {
    const live = snapshots(
      environment(codex({ version: "0.48.0", operation: operation("activating") }), "reconnecting"),
    );
    const idle = waitForManagedRuntimesIdle(live.source, [alvin]);
    expect(await settledSoon(idle)).toBe("pending");
    live.publish(environment(codex({ version: "0.50.1", operation: operation("succeeded") })));
    expect(await idle).toEqual(new Set());
  });

  it("does not take a reconnecting machine's cached idle snapshot as confirmation", async () => {
    // The server may have started an update after this snapshot was cached.
    const live = snapshots(environment(codex({ version: "0.48.0", operation: null }), "reconnecting"));
    const idle = waitForManagedRuntimesIdle(live.source, [alvin]);
    expect(await settledSoon(idle)).toBe("pending");
    live.publish(environment(codex({ version: "0.48.0", operation: operation("activating") })));
    expect(await settledSoon(idle)).toBe("pending");
    live.publish(environment(codex({ version: "0.50.1", operation: operation("succeeded") })));
    expect(await idle).toEqual(new Set());
  });

  it("reports a lost or missing machine as unconfirmed rather than idle", async () => {
    const live = snapshots(environment(codex({ version: "0.48.0", operation: null }), "lost"));
    const elsewhere = EnvironmentId.make("elsewhere");
    expect(await waitForManagedRuntimesIdle(live.source, [alvin, elsewhere])).toEqual(
      new Set([alvin, elsewhere]),
    );
  });

  it("reports a reconnect that outlasts its grace period as unconfirmed", async () => {
    const live = snapshots(environment(codex({ version: "0.48.0", operation: null }), "reconnecting"));
    expect(await waitForManagedRuntimesIdle(live.source, [alvin], 20)).toEqual(new Set([alvin]));
    expect(live.listeners.size).toBe(0);
  });

  it("ignores machines it was not asked about", async () => {
    const live = snapshots(
      environment(codex({ version: "0.48.0", operation: operation("activating") })),
    );
    const elsewhere = EnvironmentId.make("elsewhere");
    live.publish({ environmentId: elsewhere, connection: "connected", providers: [] });
    expect(await waitForManagedRuntimesIdle(live.source, [elsewhere])).toEqual(new Set());
  });

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
        await waitForManagedRuntimesIdle(live.source, [alvin]);
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

  it("does not install this app when the server accepted an update but its answer was lost", async () => {
    // The connection drops after the server starts the update: the start fails
    // here, and the cached snapshot still shows no update.
    const live = snapshots(environment(codex({ version: "0.48.0", operation: null })));
    const events: Array<string> = [];
    const pass = runUpdateEverything({
      updateProviders: async () => {
        const results = await runProviderUpdates(
          [{ environmentId: alvin, label: "alvin", items: [item] }],
          {
            updateSystem: async () => ({ status: "succeeded", version: null }),
            startManaged: async () => {
              live.publish(environment(codex({ version: "0.48.0", operation: null }), "reconnecting"));
              throw new Error("The connection closed.");
            },
          },
        );
        events.push(`providers ${results[0]!.outcome.status}`);
      },
      updateServers: async () => {},
      installLocal: async () => {
        const unconfirmed = await waitForManagedRuntimesIdle(live.source, [alvin]);
        events.push(unconfirmed.size === 0 ? "install app" : "skip install");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["providers failed"]);
    // Reconnected: the server reports the update it kept running.
    live.publish(environment(codex({ version: "0.48.0", operation: operation("activating") })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["providers failed"]);
    live.publish(environment(codex({ version: "0.50.1", operation: operation("succeeded") })));
    await pass;
    expect(events).toEqual(["providers failed", "install app"]);
  });
});
