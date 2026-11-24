import type {
  ConnectorSummary,
  ThreadMcpServerActionKind,
  ThreadMcpServerObservation,
  ThreadMcpServerStatusKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import {
  sanitizeMcpStatusDetail,
  ThreadMcpStatusRegistry,
} from "../../mcpApps/ThreadMcpStatusRegistry.ts";
import { ConnectorRuntime, ExtensionDeliveryReceipts } from "./ExtensionsServices.ts";

const managedStatusOf = (
  connector: ConnectorSummary,
): {
  readonly status: ThreadMcpServerStatusKind;
  readonly detail?: string | undefined;
  readonly action?: ThreadMcpServerActionKind | undefined;
} => {
  const detail = sanitizeMcpStatusDetail(connector.lastError);
  if (connector.status === "needs-auth") {
    return {
      status: "needs-sign-in",
      ...(detail === undefined ? {} : { detail }),
      action: "sign-in",
    };
  }
  if (connector.status === "needs-credential") {
    return {
      status: "credential-rejected",
      ...(detail === undefined ? {} : { detail }),
      action: "manage",
    };
  }
  if (detail !== undefined && /permission|scope|forbidden/i.test(detail)) {
    return {
      status: "permissions-required",
      detail,
      action: "manage",
    };
  }
  if (detail !== undefined) {
    return {
      status: "unreachable",
      detail,
      action: "retry",
    };
  }
  return { status: "ready" };
};

/**
 * Registers Scient's live connector runtime and per-thread delivery receipts as a managed source
 * on ThreadMcpStatusRegistry when the registry is present in the server environment.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(ThreadMcpStatusRegistry);
    if (Option.isNone(registry)) return;
    const connectors = yield* ConnectorRuntime;
    const receipts = yield* ExtensionDeliveryReceipts;
    const sessions = yield* Effect.serviceOption(McpProviderSessions.McpProviderSessions);
    const unregister = yield* registry.value.registerManagedSource({
      snapshot: Effect.fn("ScientThreadMcpStatusBridge.snapshot")(function* ({
        threadId,
        sessionActive,
      }) {
        const observations: ThreadMcpServerObservation[] = [];
        if (Option.isSome(sessions) && connectors.pluginKeyRefusals !== undefined) {
          const session = yield* sessions.value.read(threadId);
          const deliveredIds = new Set(session?.connectors.map((entry) => entry.connectorId));
          const observedAt = DateTime.formatIso(yield* DateTime.now);
          for (const refused of yield* connectors.pluginKeyRefusals()) {
            if (!deliveredIds.has(refused.connectorId)) continue;
            observations.push({
              id: `managed:${refused.connectorId}`,
              // The registration's own bounded alias; the plugin-prefixed name can run long.
              name: refused.serverName,
              displayName: refused.displayName,
              source: "managed",
              status: "credential-rejected",
              observedAt,
              detail: "The key bound in Scient Accounts was rejected. Update that account.",
              action: "manage",
              sessionActive,
            });
          }
        }
        const receipt = Option.getOrUndefined(yield* receipts.get(threadId));
        if (receipt === undefined) return observations;
        const listed = yield* connectors.list();
        const byId = new Map(listed.connectors.map((c) => [c.connectorId, c] as const));
        const seen = new Set<string>();
        const addManaged = (connectorId: ConnectorSummary["connectorId"]) => {
          if (seen.has(connectorId)) return;
          const summary = byId.get(connectorId);
          if (summary === undefined || !summary.enabled) return;
          seen.add(connectorId);
          const derived = managedStatusOf(summary);
          observations.push({
            id: `managed:${summary.connectorId}`,
            name: summary.serverName,
            displayName: summary.displayName,
            source: "managed",
            status: derived.status,
            observedAt: summary.updatedAt,
            ...(derived.detail === undefined ? {} : { detail: derived.detail }),
            ...(derived.action === undefined ? {} : { action: derived.action }),
            managedId: summary.connectorId,
            sessionActive,
          });
        };
        for (const entry of receipt.delivered) addManaged(entry.connectorId);
        for (const skipped of receipt.skipped) {
          if (skipped.reason === "needs-auth" || skipped.reason === "needs-credential") {
            addManaged(skipped.entry.connectorId);
          }
        }
        return observations;
      }),
      changes: Stream.merge(
        Stream.map(connectors.changes, () => null),
        receipts.changes,
      ),
    });
    yield* Effect.addFinalizer(() => unregister);
  }),
);
