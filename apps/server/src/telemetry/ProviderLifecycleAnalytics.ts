import type { ServerProvider } from "@t3tools/contracts";

const MAX_INSTANCES = 1_000;

interface Operation {
  readonly key: string;
  readonly action: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: "completed" | "failed" | "cancelled" | null;
}

interface Snapshot {
  readonly installed: boolean;
  readonly source: string;
  readonly state: string;
  readonly runtime: Operation | null;
  readonly connection: Operation | null;
  readonly update: Operation | null;
}

interface Event {
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

function snapshot(provider: ServerProvider): Snapshot {
  const runtime = provider.connection?.runtime;
  const operation = runtime?.operation;
  const connection = provider.connection?.operation;
  const update = provider.updateState;
  return {
    installed: provider.installed,
    source: provider.installed ? (runtime?.source ?? "unknown") : "missing",
    state: provider.status,
    runtime: operation
      ? {
          key: operation.operationId,
          action: operation.action,
          stage: operation.status,
          startedAt: operation.startedAt,
          finishedAt: operation.finishedAt,
          outcome:
            operation.status === "succeeded"
              ? "completed"
              : operation.status === "failed" || operation.status === "cancelled"
                ? operation.status
                : null,
        }
      : null,
    connection: connection
      ? {
          key: connection.operationId,
          action: "sign-in",
          stage: connection.status,
          startedAt: connection.startedAt,
          finishedAt: connection.finishedAt,
          outcome:
            connection.status === "connected"
              ? "completed"
              : connection.status === "failed" || connection.status === "cancelled"
                ? connection.status
                : null,
        }
      : null,
    update:
      update?.startedAt && update.status !== "idle"
        ? {
            key: update.startedAt,
            action: "update",
            stage: update.status,
            startedAt: update.startedAt,
            finishedAt: update.finishedAt,
            outcome:
              update.status === "succeeded" || update.status === "unchanged"
                ? "completed"
                : update.status === "failed"
                  ? "failed"
                  : null,
          }
        : null,
  };
}

function lifecycleEvent(
  provider: string,
  source: string,
  previous: Operation | null,
  next: Operation | null,
): Event | null {
  if (!next) return null;
  const sameOperation = previous?.key === next.key;
  if (sameOperation && previous.outcome !== null) return null;
  // A terminal snapshot without an observed start may predate consent or this
  // server session. Never replay it as a new completed operation.
  if (!sameOperation && next.outcome !== null) return null;
  if (sameOperation && next.outcome === null) return null;
  const durationMs =
    next.finishedAt === null ? undefined : Date.parse(next.finishedAt) - Date.parse(next.startedAt);
  return {
    name: `provider.lifecycle.${next.outcome ?? "started"}`,
    properties: {
      provider,
      action: next.action,
      source,
      stage: next.outcome === null ? next.stage : (previous?.stage ?? "unknown"),
      durationMs,
      // The UI message is deliberately not inspected: it can contain paths,
      // credentials, provider output, or URLs. Typed classifications can be
      // added at their owner without changing this snapshot boundary.
      failureClass: "unknown",
    },
  };
}

/** Observes canonical snapshots without storing account, path, model, or message data. */
export function createProviderLifecycleAnalyticsMapper() {
  const previous = new Map<string, Snapshot>();
  // Installation analytics is provider-level, not instance-level. A user may
  // configure several instances of one driver, and exposing instance IDs would
  // add unnecessary identity surface. "Installed" therefore means that at
  // least one settled instance of the provider is installed.
  const previousInstallations = new Map<string, boolean>();
  const observedStarts = new Map<
    string,
    Partial<Record<"runtime" | "connection" | "update", string>>
  >();
  let initialized = false;

  const observe = (providers: ReadonlyArray<ServerProvider>): ReadonlyArray<Event> => {
    const events: Event[] = [];
    const present = new Set<string>();
    const presentDrivers = new Set<string>();
    const pendingDrivers = new Set<string>();
    const installations = new Map<string, boolean>();
    const limitedProviders = providers.slice(0, MAX_INSTANCES);

    for (const provider of limitedProviders) {
      const driver = String(provider.driver);
      presentDrivers.add(driver);
      if (provider.probePending) {
        pendingDrivers.add(driver);
        continue;
      }
      installations.set(driver, (installations.get(driver) ?? false) || provider.installed);
    }

    for (const [driver, installed] of installations) {
      // Do not publish a provisional aggregate while any instance of the same
      // provider is still being probed.
      if (pendingDrivers.has(driver)) continue;
      const before = previousInstallations.get(driver);
      if (before === undefined) {
        events.push({
          name: "provider.installation.observed",
          properties: { provider: driver, installed },
        });
      } else if (before !== installed) {
        events.push({
          name: "provider.installation.changed",
          properties: { provider: driver, fromInstalled: before, toInstalled: installed },
        });
      }
      previousInstallations.set(driver, installed);
    }

    for (const driver of previousInstallations.keys())
      if (!presentDrivers.has(driver)) previousInstallations.delete(driver);

    for (const provider of limitedProviders) {
      const id = String(provider.instanceId);
      present.add(id);
      if (provider.probePending) continue;
      const before = previous.get(id);
      const next = snapshot(provider);
      previous.set(id, next);
      const driver = String(provider.driver);
      if (before) {
        if (before.state !== next.state)
          events.push({
            name: "provider.readiness.changed",
            properties: { provider: driver, from: before.state, to: next.state },
          });
        if (before.source !== next.source)
          events.push({
            name: "provider.runtime.source.changed",
            properties: { provider: driver, from: before.source, to: next.source },
          });
      }
      if (!initialized || !before) continue;
      const admitted = observedStarts.get(id) ?? {};
      observedStarts.set(id, admitted);
      for (const key of ["runtime", "connection", "update"] as const) {
        const event = lifecycleEvent(driver, before.source, before[key], next[key]);
        if (!event) continue;
        if (event.name === "provider.lifecycle.started") {
          admitted[key] = next[key]!.key;
        } else {
          if (admitted[key] !== next[key]!.key) continue;
          delete admitted[key];
        }
        events.push(event);
      }
    }
    for (const key of previous.keys())
      if (!present.has(key)) {
        previous.delete(key);
        observedStarts.delete(key);
      }
    initialized = true;
    return events;
  };

  return {
    observe,
    clear: () => {
      previous.clear();
      previousInstallations.clear();
      observedStarts.clear();
      initialized = false;
    },
  };
}
