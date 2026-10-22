/**
 * Computes which Scient connectors one provider session receives when its MCP
 * credential is prepared, and records the thread's delivery receipt.
 *
 * delivered = eligible (connected ∧ enabled ∧ allowed for the project, decided
 *             by ConnectorRuntime) ∧ the driver can carry remote HTTP MCP
 *             ∧ no provider-native MCP server already uses the name.
 *
 * Without a ConnectorRuntime in context nothing is delivered; without a
 * receipts store nothing is recorded. See docs/internals/scient-extensions.md.
 */
import type {
  ExtensionDeliveryEntry,
  ExtensionDeliverySkipReason,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type {
  McpConnectorRegistrationReporter,
  McpProviderSessionConnector,
} from "@t3tools/provider-core/server/mcpSession";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import {
  connectorTransportSupport,
  type ConnectorTransportSupport,
} from "./ConnectorProviderSupport.ts";
import {
  ConnectorRuntime,
  type ConnectorDeliveryResolution,
  type EligibleConnector,
  ExtensionDeliveryReceipts,
} from "./ExtensionsServices.ts";

export interface SkippedConnector extends EligibleConnector {
  readonly reason: ExtensionDeliverySkipReason;
}

export interface ConnectorDeliveryPlan {
  /** Connectors the session receives, in the runtime's stable order. */
  readonly delivered: ReadonlyArray<EligibleConnector>;
  readonly skipped: ReadonlyArray<SkippedConnector>;
}

const NO_CONNECTORS: ConnectorDeliveryPlan = { delivered: [], skipped: [] };

/**
 * Applies the session-specific filters to the runtime's eligibility answer.
 * `nativeServerNames` is undefined when the provider has not reported its
 * native servers, which means no collision can be detected.
 */
export const planConnectorDelivery = (input: {
  readonly resolution: ConnectorDeliveryResolution;
  readonly support: ConnectorTransportSupport;
  readonly nativeServerNames: ReadonlySet<string> | undefined;
}): ConnectorDeliveryPlan => {
  if (input.support.status === "unsupported") {
    return {
      delivered: [],
      skipped: [
        ...input.resolution.skipped,
        ...input.resolution.eligible.map((connector) => ({
          ...connector,
          reason: "transport-unsupported" as const,
        })),
      ],
    };
  }
  const delivered: Array<EligibleConnector> = [];
  const collided: Array<SkippedConnector> = [];
  for (const connector of input.resolution.eligible) {
    if (input.nativeServerNames?.has(connector.serverName) === true) {
      collided.push({ ...connector, reason: "name-collision" });
    } else {
      delivered.push(connector);
    }
  }
  return { delivered, skipped: [...input.resolution.skipped, ...collided] };
};

/**
 * A credential can be reused only when it was issued for exactly this
 * connector set under the same names: agents address connectors by name.
 */
export const sameDeliveredConnectors = (
  issued: ReadonlyArray<McpProviderSessionConnector>,
  scopeConnectorIds: ReadonlySet<string> | undefined,
  planned: ReadonlyArray<EligibleConnector>,
): boolean =>
  issued.length === planned.length &&
  (scopeConnectorIds?.size ?? 0) === planned.length &&
  planned.every(
    (connector, index) =>
      issued[index]?.connectorId === connector.connectorId &&
      issued[index]?.serverName === connector.serverName &&
      issued[index]?.displayName === connector.displayName &&
      scopeConnectorIds?.has(connector.connectorId) === true,
  );

const receiptEntry = (connector: EligibleConnector): ExtensionDeliveryEntry => ({
  kind: "connector",
  connectorId: connector.connectorId,
  serverName: connector.serverName,
  displayName: connector.displayName,
});

type Withheld = Parameters<McpConnectorRegistrationReporter>[0]["withheld"];

interface TrackerState {
  /** Serializes reports and receipt re-recording for one credential. */
  readonly lock: Semaphore.Semaphore;
  started: number;
  reported: number;
  /** The latest accepted registration outcome; empty until one reports. */
  lastWithheld: Withheld;
}

export const make = Effect.gen(function* () {
  const runtime = yield* Effect.serviceOption(ConnectorRuntime);
  const receipts = yield* Effect.serviceOption(ExtensionDeliveryReceipts);
  /**
   * Keyed by the tracker effect a credential carries on its MCP config, so
   * the state lives exactly as long as that credential's config.
   */
  const trackers = new WeakMap<Effect.Effect<McpConnectorRegistrationReporter>, TrackerState>();

  /**
   * The project and provider snapshot are read only when connectors can be
   * delivered at all. A session without an MCP injection channel (for example
   * an external OpenCode server) receives nothing, whatever its driver.
   */
  const plan = Effect.fn("ConnectorSessionDelivery.plan")(function* (input: {
    readonly driver: ProviderDriverKind;
    readonly mcpInjection: boolean;
    readonly projectId: Effect.Effect<ProjectId | undefined>;
    readonly provider: Effect.Effect<ServerProvider | undefined>;
  }) {
    if (Option.isNone(runtime)) return NO_CONNECTORS;
    const resolution = yield* runtime.value.resolveDelivery({ projectId: yield* input.projectId });
    const support: ConnectorTransportSupport = input.mcpInjection
      ? connectorTransportSupport(input.driver)
      : { status: "unsupported", reason: "This session has no Scient MCP channel." };
    const nativeServers =
      support.status === "unsupported" || resolution.eligible.length === 0
        ? undefined
        : (yield* input.provider)?.mcpServers;
    return planConnectorDelivery({
      resolution,
      support,
      nativeServerNames:
        nativeServers === undefined ? undefined : new Set(nativeServers.map(({ name }) => name)),
    });
  });

  /**
   * `registration` is the credential's tracker when an existing credential is
   * reused: its latest registration outcome is applied in the same step, so a
   * receipt recorded after the thread's receipt was replaced or evicted never
   * shows a withheld connector as delivered.
   */
  const record = Effect.fn("ConnectorSessionDelivery.record")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: string;
    readonly issuedAtMillis: number;
    readonly plan: ConnectorDeliveryPlan;
    readonly registration?: Effect.Effect<McpConnectorRegistrationReporter> | undefined;
  }) {
    if (Option.isNone(receipts)) return;
    const store = receipts.value;
    const receipt = {
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
      issuedAt: DateTime.formatIso(DateTime.makeUnsafe(input.issuedAtMillis)),
      delivered: input.plan.delivered.map(receiptEntry),
      skipped: input.plan.skipped.map((connector) => ({
        entry: receiptEntry(connector),
        reason: connector.reason,
      })),
    };
    const tracker = input.registration === undefined ? undefined : trackers.get(input.registration);
    yield* tracker === undefined
      ? store.record(receipt)
      : tracker.lock.withPermits(1)(
          Effect.suspend(() => store.record(receipt, { withheld: tracker.lastWithheld })),
        );
  });

  /**
   * The tracker one credential carries to its adapter, created once when the
   * credential is issued and shared by every session that reuses it. Running
   * it starts a registration and takes the next sequence; the returned
   * reporter applies that registration's settled outcome to this runtime's
   * receipt store unless a registration that started later already reported.
   * The ordering state and the latest outcome live here, with the credential,
   * so replacing or evicting the thread's receipt cannot reset them.
   */
  const registrationTrackerFor = (credential: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
  }): Effect.Effect<McpConnectorRegistrationReporter> => {
    if (Option.isNone(receipts)) return Effect.succeed(() => Effect.void);
    const store = receipts.value;
    const state: TrackerState = {
      lock: Semaphore.makeUnsafe(1),
      started: 0,
      reported: 0,
      lastWithheld: [],
    };
    const begin = Effect.sync((): McpConnectorRegistrationReporter => {
      const sequence = ++state.started;
      return (outcome) =>
        // Check and write as one step, so an older report cannot land after a newer one.
        state.lock.withPermits(1)(
          Effect.suspend(() => {
            if (sequence <= state.reported) return Effect.void;
            state.reported = sequence;
            state.lastWithheld = outcome.withheld;
            return store.reportRegistration({ ...credential, ...outcome });
          }),
        );
    });
    trackers.set(begin, state);
    return begin;
  };

  return { plan, record, registrationTrackerFor };
});
