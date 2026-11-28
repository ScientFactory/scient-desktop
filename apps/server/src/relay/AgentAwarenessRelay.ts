import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import {
  isListedThreadLineage,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type Project,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import {
  RelayApi,
  type RelayAgentActivityPublishProofPayload,
  type RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import {
  type SubagentRequestAwareness,
  projectThreadAwarenessV2,
  subagentAwaitsUser,
  turnItemCanChangeUserWait,
} from "@t3tools/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { normalizeRelayIssuer, RELAY_ACTIVITY_PUBLISH_TYP } from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
// SCIENT-FORK:START — Scient Accounts: a sign-in waiting for the user reaches their phone.
import type { AccountCodeNotice, AccountsSnapshot } from "@t3tools/contracts";
import {
  accountRequestsByThread,
  isScientBackgroundThread,
} from "@t3tools/shared/scientSignInPage";
import type { AccountsError } from "@t3tools/contracts";
import { AccountsService } from "../scient/accounts/AccountsService.ts";
import { isCodeNotice } from "../scient/accounts/signInCodes.ts";
// SCIENT-FORK:END
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly requestCatchUp: () => Effect.Effect<void>;
    // SCIENT-FORK:START — Scient Accounts: a link change waits for a notice acknowledgement's commit.
    /** Runs a change of the relay link in the acknowledgements' turn, then ends the old connection. */
    readonly replacingLink: <A, E, R>(change: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    // SCIENT-FORK:END
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/AgentAwarenessRelay") {}

function eventThreadId(event: OrchestrationV2DomainEvent): ThreadId {
  return event.threadId;
}

function isTurnItemPayload(
  payload: unknown,
): payload is Pick<OrchestrationV2TurnItem, "type" | "status"> {
  return (
    typeof payload === "object" && payload !== null && "type" in payload && "status" in payload
  );
}

function shouldPublishAgentAwarenessEvent(
  event: Pick<OrchestrationV2DomainEvent, "type"> & { readonly payload?: unknown },
): boolean {
  if (
    event.type === "thread.created" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "historyOrigin" in event.payload &&
    event.payload.historyOrigin === "v1_import"
  ) {
    return false;
  }
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.pull-request-link-updated":
    case "thread.pull-request-synced":
    case "thread.issue-synced":
    case "thread.settled":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "subagent.updated":
    case "provider-thread.updated":
      return true;
    // Unsettling must not re-alert a dismissed result.
    case "thread.unsettled":
    case "thread.guest-share-updated":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.tags-updated":
    case "thread.visited":
    case "thread.visit-recorded":
    case "thread.marked-unread":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "run.background-work-cancelled":
    case "run.output-submitted":
    case "run-attempt.created":
    case "run-attempt.updated":
    case "node.updated":
    case "provider-session.attached":
    case "provider-session.updated":
    case "provider-session.detached":
    case "provider-turn.updated":
    case "turn-item.updated":
      return (
        isTurnItemPayload(event.payload) &&
        (turnItemUpdateCanEndBackgroundWork(event.payload) ||
          turnItemCanChangeUserWait(event.payload))
      );
    case "message.updated":
    case "plan.updated":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
      return false;
  }
}

export const makeAgentAwarenessPublishWorker = Effect.fnUntraced(function* <R>(
  publish: (threadId: ThreadId) => Effect.Effect<void, never, R>,
) {
  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(Effect.andThen(publish(threadId))),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      // Remove queued IDs when processing starts so publication can queue one later update.
      queued.add(threadId);
      return worker.enqueue(threadId);
    }).pipe(Effect.uninterruptible);
  return { enqueue, drain: worker.drain };
});

function agentAwarenessPublishIdentity(
  state: RelayAgentActivityState | null,
  subagentRequest: SubagentRequestAwareness | null = null,
): string {
  if (state === null) {
    return "null";
  }
  const { updatedAt: _updatedAt, ...meaningfulState } = state;
  // A child's next request reads the same as its last one, but it is a new
  // wait and must reach the phone.
  return JSON.stringify(
    subagentRequest === null ? meaningfulState : [meaningfulState, subagentRequest.requestId],
  );
}

const CLEARED_PUBLISH_IDENTITY = agentAwarenessPublishIdentity(null);

// A published tombstone stays recorded so repeats are skipped, but it is not live state.
function hasLivePublishedState(
  publishedStateByThread: ReadonlyMap<ThreadId, string>,
  threadId: ThreadId,
): boolean {
  const identity = publishedStateByThread.get(threadId);
  return identity !== undefined && identity !== CLEARED_PUBLISH_IDENTITY;
}

function resolveAgentActivityPublishingStartupState(input: {
  readonly relayConfigured: boolean;
  readonly publishEnabled: boolean;
}): "waiting-for-link" | "disabled" | "enabled" {
  if (!input.relayConfigured) {
    return "waiting-for-link";
  }
  return input.publishEnabled ? "enabled" : "disabled";
}

const RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH = 160;
const REDACTED_RELAY_AGENT_FAILURE_DETAIL = "The agent run failed.";
const RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
// Nothing else re-queues a thread when the network returns, so a lost terminal state is retried until it lands.
const RELAY_AGENT_ACTIVITY_STEADY_RETRY_DELAY_MS = 60_000;

function sanitizeRelayAgentActivityState(
  state: RelayAgentActivityState | null,
): RelayAgentActivityState | null {
  if (state === null) {
    return null;
  }
  const { detail: _detail, ...rest } = state;
  const detail = (state.phase === "failed" ? REDACTED_RELAY_AGENT_FAILURE_DETAIL : state.detail)
    ?.trim()
    .slice(0, RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH)
    .trim();
  return detail ? { ...rest, detail } : rest;
}

function relayEnvironmentClient(token: string) {
  return HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
}

function deliveryStats(
  deliveries: ReadonlyArray<{
    readonly ok: boolean;
    readonly queued?: boolean | undefined;
    readonly kind: string;
    readonly apnsStatus?: number | null;
    readonly apnsReason?: string | null;
  }>,
) {
  let queued = 0;
  let successful = 0;
  let failed = 0;
  const failedReasons: string[] = [];
  const kinds = new Set<string>();

  for (const delivery of deliveries) {
    kinds.add(delivery.kind);
    if (delivery.queued) {
      queued += 1;
      continue;
    }
    if (delivery.ok) {
      successful += 1;
      continue;
    }
    failed += 1;
    failedReasons.push(`${delivery.apnsStatus ?? "transport"}:${delivery.apnsReason ?? "unknown"}`);
  }

  return {
    total: deliveries.length,
    queued,
    successful,
    failed,
    kinds: [...kinds],
    failedReasons,
  };
}

const makePublishProof = Effect.fn("makePublishProof")(function* (input: {
  readonly relayIssuer: string;
  readonly environmentId: string;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly jti: string;
}) {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const payload = {
    iss: `t3-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(input.relayIssuer),
    sub: input.environmentId,
    jti: input.jti,
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    environmentId: input.environmentId as RelayAgentActivityPublishProofPayload["environmentId"],
    threadId: input.threadId,
    state: input.state,
  } satisfies RelayAgentActivityPublishProofPayload;
  const signingKey = yield* EnvironmentSigningKey;
  return yield* signingKey.sign({ typ: RELAY_ACTIVITY_PUBLISH_TYP, payload });
});

function describeThreadShellForAwareness(
  thread: Option.Option<AgentAwarenessThread>,
): Record<string, unknown> {
  if (Option.isNone(thread)) {
    return { found: false };
  }
  const shell = thread.value;
  return {
    found: true,
    status: shell.status,
    activityRunStatus: shell.activityRunStatus ?? null,
    activeRunId: shell.activeRunId ?? null,
    latestRunId: shell.latestRunId ?? null,
    pendingRuntimeRequestKind: shell.pendingRuntimeRequest?.kind ?? null,
    hasActionableProposedPlan: shell.hasActionableProposedPlan,
  };
}

interface SubagentRequest {
  readonly topLevelThreadId: ThreadId;
  readonly requestId: RuntimeRequestId;
}

interface SubagentAlert {
  readonly requestId: RuntimeRequestId;
  readonly updatedAt: string;
}

const waitingApprovalId = (thread: AgentAwarenessThread | null) =>
  thread !== null && thread.archivedAt === null && subagentAwaitsUser(thread)
    ? thread.pendingRuntimeRequest?.id
    : undefined;

function resolveAgentAwarenessRelayPublishSnapshot(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Option.Option<AgentAwarenessThread>;
  readonly project: Option.Option<Project>;
  readonly pendingSubagentRequest: SubagentRequestAwareness | null;
}): {
  readonly projectId: string | null;
  readonly state: RelayAgentActivityState | null;
  /** The child request behind the state's wait, when the parent isn't waiting itself. */
  readonly subagentWait: SubagentRequestAwareness | null;
  readonly reason: "snapshot" | "thread-not-found" | "project-not-found";
} {
  if (Option.isNone(input.thread)) {
    return {
      projectId: null,
      state: null,
      subagentWait: null,
      reason: "thread-not-found",
    };
  }
  if (Option.isNone(input.project)) {
    return {
      projectId: input.thread.value.projectId,
      state: null,
      subagentWait: null,
      reason: "project-not-found",
    };
  }
  const awarenessInput = {
    environmentId: input.environmentId,
    project: input.project.value,
    thread: input.thread.value,
  };
  const state = projectThreadAwarenessV2({
    ...awarenessInput,
    pendingSubagentRequest: input.pendingSubagentRequest,
  });
  const childDrivesWait =
    input.pendingSubagentRequest !== null &&
    state?.phase !== projectThreadAwarenessV2(awarenessInput)?.phase;
  return {
    projectId: input.thread.value.projectId,
    state: snoozedCompletion(input.thread.value, state)
      ? null
      : sanitizeRelayAgentActivityState(state),
    subagentWait: childDrivesWait ? input.pendingSubagentRequest : null,
    reason: "snapshot",
  };
}

// SCIENT-FORK:START — Scient Accounts: a sign-in waiting for the user reaches their phone.
function withAccountRequest<S extends { readonly state: RelayAgentActivityState | null }>(
  snapshot: S,
  request: string | undefined,
  /** Scient's own background thread, which has no shell: its waiting sign-in still reaches the phone. */
  background?: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly updatedAt: string;
  },
): S {
  if (request !== undefined && snapshot.state === null && background !== undefined)
    return {
      ...snapshot,
      state: {
        environmentId: background.environmentId,
        threadId: background.threadId,
        projectTitle: "Scient",
        threadTitle: "Accounts",
        phase: "waiting_for_approval",
        headline: "An account needs you",
        detail: request,
        modelTitle: "Scient",
        updatedAt: background.updatedAt,
        deepLink: `/threads/${encodeURIComponent(background.environmentId)}/${encodeURIComponent(background.threadId)}`,
      },
    };
  if (request === undefined || snapshot.state === null) return snapshot;
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      phase: "waiting_for_approval",
      headline: "An account needs you",
      detail: request,
    },
  };
}
/**
 * A phone notice is two rows. The notice itself never changes while it stands, so a push the relay
 * queued for it stays the one to deliver; "Signed in" or "Not signed in" is a second row. Both go
 * once the notice's time is up (`NOTICE_ROW_MS`).
 */
const noticeThread = (noticeId: string) => ThreadId.make(`scient-accounts-notice-${noticeId}`);
const settledThread = (noticeId: string) =>
  ThreadId.make(`scient-accounts-notice-${noticeId}-done`);
/** Link reads and acknowledgements share the link turn; a link change takes all of it. */
const LINK_TURN_PERMITS = 1024;
/** A link change waits this long, at most, for the acknowledgements under way. */
const LINK_CHANGE_WAIT_MS = 15_000;
/** Each acknowledgement try is bounded; a busy Accounts is tried again after these waits. */
const ACK_TRY_MS = 10_000;
const ACK_RETRY_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
/** How long a notice and its outcome stand on the phone; a code is long expired by then. */
const NOTICE_ROW_MS = 30 * 60 * 1000;

interface NoticeRow {
  readonly notice: AccountCodeNotice;
  readonly role: "notice" | "settled";
}

/** The row as the phone shows it now, or null once its time is up or before there is anything. */
function noticeState(
  environmentId: EnvironmentId,
  { notice, role }: NoticeRow,
  nowMs: number,
): RelayAgentActivityState | null {
  if (nowMs - Date.parse(notice.at) >= NOTICE_ROW_MS) return null;
  const threadId =
    role === "notice" ? noticeThread(notice.noticeId) : settledThread(notice.noticeId);
  const deepLink = `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  const common = {
    environmentId,
    threadId,
    projectTitle: "Accounts",
    modelTitle: "Scient",
    deepLink,
  };
  if (role === "notice")
    return {
      ...common,
      threadTitle: notice.text,
      phase: "waiting_for_approval",
      headline: notice.text,
      updatedAt: notice.at,
    };
  if (notice.settled === undefined || notice.settledAt === undefined) return null;
  const outcome = notice.settled === "signed-in" ? "Signed in" : "Not signed in";
  return {
    ...common,
    threadTitle: `${notice.text} · ${outcome}`,
    phase: "completed",
    headline: outcome,
    // Shown, not pushed: a silent row adds no second alert to the notice's, dated as it settled.
    updatedAt: notice.settledAt,
    silent: true,
  };
}
// SCIENT-FORK:END
// Checked at completion time, so a completion processed after the wake stays silent too.
function snoozedCompletion(
  thread: AgentAwarenessThread,
  state: { readonly phase: string } | null,
): boolean {
  if (state?.phase !== "completed" || thread.latestRunCompletedAt == null) return false;
  const completedAt = DateTime.toEpochMillis(thread.latestRunCompletedAt);
  if (thread.snoozedAt != null && completedAt < DateTime.toEpochMillis(thread.snoozedAt)) {
    return false;
  }
  return isSnoozed(thread, completedAt);
}

function terminalWorkSinceStart(thread: AgentAwarenessThread, startedAt: number): boolean {
  return (
    thread.latestRunCompletedAt != null &&
    DateTime.toEpochMillis(thread.latestRunCompletedAt) > startedAt
  );
}

export function resolveAgentAwarenessRelayActiveThreadIds(input: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: number;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "title">>;
  readonly threads: ReadonlyArray<AgentAwarenessThread>;
}): ReadonlyArray<ThreadId> {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  return input.threads
    .filter((thread) => {
      // Publishing a waiting subagent republishes its top-level thread.
      if (subagentAwaitsUser(thread)) return true;
      const project = thread.projectId === null ? undefined : projectById.get(thread.projectId);
      if (!project) {
        return false;
      }
      const state = projectThreadAwarenessV2({
        environmentId: input.environmentId,
        project,
        thread,
      });
      return (
        state !== null &&
        (state.phase !== "completed" && state.phase !== "failed"
          ? true
          : terminalWorkSinceStart(thread, input.startedAt))
      );
    })
    .map((thread) => thread.id);
}

/** @public */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const signingKey = yield* EnvironmentSigningKey;
  const scope = yield* Effect.scope;
  // SCIENT-FORK:START — Scient Accounts: a sign-in waiting for the user reaches their phone.
  const accounts = yield* Effect.serviceOption(AccountsService);
  let accountRequests: ReadonlyMap<string, string> = new Map();
  let codeNotices: ReadonlyMap<string, NoticeRow> = new Map();
  /** Notices whose retirement is already scheduled. */
  const retiring = new Set<string>();
  // SCIENT-FORK:END
  const startedAt = (yield* DateTime.now).epochMilliseconds;
  const catchUpRequests = yield* Queue.dropping<void>(1);
  const publishedStateByThreadRef = yield* Ref.make(new Map<ThreadId, string>());
  // Android keys alerts by phase and time, so a child's unchanged request keeps
  // its first alert time through parent renames, relinks and the parent's own requests.
  const childAlertByThread = new Map<ThreadId, SubagentAlert>();
  const subagentRequests = new Map<ThreadId, SubagentRequest>();

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
      );

  const readRelayConfig = Effect.gen(function* () {
    const [url, issuer, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ISSUER_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    return url && environmentCredential
      ? { url, issuer: issuer ?? url, environmentCredential }
      : null;
  });

  const readPublishAgentActivityEnabled = readSecretString(PUBLISH_AGENT_ACTIVITY_SECRET).pipe(
    Effect.map(isAgentActivityPublishingEnabledValue),
  );

  const makeRelayClient = (relayConfig: {
    readonly url: string;
    readonly environmentCredential: string;
  }) =>
    HttpApiClient.make(RelayApi, {
      baseUrl: relayConfig.url,
      transformClient: relayEnvironmentClient(relayConfig.environmentCredential),
    }).pipe(Effect.provide(FetchHttpClient.layer));

  let cachedRelayClient: Effect.Success<ReturnType<typeof makeRelayClient>> | undefined;
  // SCIENT-FORK:START — Scient Accounts: a publish begun on an older connection doesn't stand for the new one.
  /**
   * Bumped on every reset. A publish that finishes on an older connection caches no client,
   * records nothing as published and acknowledges no notice: it goes again on the new one.
   */
  let connection = 0;
  /**
   * Runs a notice acknowledgement in the link turn, a bounded try at a time, retried while Accounts
   * is busy; it stops once its link is replaced (and the row goes again on the new one).
   */
  const acknowledgeTries = Effect.fn("AgentAwarenessRelay.acknowledgeNotice")(function* (
    ack: () => Effect.Effect<void, AccountsError>,
    stale: () => boolean,
    threadId: ThreadId,
  ) {
    // Until it lands or its link is replaced, whatever the publish dedup holds.
    for (let attempt = 0; ; attempt++) {
      if (stale()) return yield* publishAgain(threadId);
      const done = yield* linkShare(Effect.suspend(ack)).pipe(
        Effect.timeoutOption(ACK_TRY_MS),
        Effect.result,
      );
      if (Result.isSuccess(done) && Option.isSome(done.success))
        return stale() ? yield* publishAgain(threadId) : undefined;
      yield* Effect.logWarning("Accounts didn't keep the notice acknowledgement; it is retried", {
        threadId,
        reason: Result.isFailure(done) ? done.failure.message : "Accounts was busy",
      });
      yield* Effect.sleep(ACK_RETRY_MS[Math.min(attempt, ACK_RETRY_MS.length - 1)]!);
    }
  });
  const acknowledge = (
    ack: () => Effect.Effect<void, AccountsError>,
    stale: () => boolean,
    threadId: ThreadId,
  ) => acknowledgeTries(ack, stale, threadId).pipe(Effect.forkIn(scope), Effect.asVoid);
  /** Queues a thread's publish again, on its own queue; set once the queues exist. */
  let publishAgain: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  /**
   * Shared by link reads and notice acknowledgements (one permit each, side by side), whole for a
   * link change: no acknowledgement commits, and no link is read, while the link changes.
   */
  const linkTurn = yield* Semaphore.make(LINK_TURN_PERMITS);
  /** Taken by a link change for its whole wait: a reader arriving meanwhile goes after it. */
  const linkGate = yield* Semaphore.make(1);
  const linkShare = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    linkGate
      .withPermits(1)(Effect.void)
      .pipe(Effect.andThen(linkTurn.withPermits(1)(effect)));
  /**
   * A link change waits for the acknowledgements under way, a bounded time: one stuck in
   * Accounts' write can't hold the link. Its generation ends with the change either way.
   */
  const linkChange = <A, E, R>(change: Effect.Effect<A, E, R>) =>
    linkGate.withPermits(1)(
      Effect.gen(function* () {
        const turn = yield* linkTurn
          .take(LINK_TURN_PERMITS)
          .pipe(Effect.timeoutOption(LINK_CHANGE_WAIT_MS));
        if (Option.isNone(turn))
          yield* Effect.logWarning(
            "A notice acknowledgement held the relay link too long; the link changes anyway",
          );
        return yield* change.pipe(
          Effect.ensuring(Option.isSome(turn) ? linkTurn.release(LINK_TURN_PERMITS) : Effect.void),
        );
      }),
    );
  // SCIENT-FORK:END
  let publishedRelayConfig: NonNullable<Effect.Success<typeof readRelayConfig>> | undefined;

  // Confirm through the same worker so tombstones cannot race live updates; recovery clears the deadline.
  const publishConfirmDeadlines = new Map<ThreadId, number>();
  // Threads whose confirmation holds a completion, so a thread that settles during the hold still alerts.
  const heldCompletions = new Set<ThreadId>();
  let schedulePublishConfirm: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  const publishRetries = new Map<
    ThreadId,
    { readonly attempts: number; timer: Fiber.Fiber<void> | undefined }
  >();
  const cancelPublishRetry = Effect.fnUntraced(function* (threadId: ThreadId) {
    const retry = publishRetries.get(threadId);
    publishRetries.delete(threadId);
    if (retry?.timer !== undefined) yield* Fiber.interrupt(retry.timer);
  });
  const cancelPublishRetries = Effect.suspend(() =>
    Effect.forEach([...publishRetries.keys()], cancelPublishRetry, { discard: true }),
  );
  let schedulePublishRetry: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  let enqueueTopLevelPublish: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  const resetPublishedConnection = Effect.gen(function* () {
    // SCIENT-FORK:START — Scient Accounts: a publish begun on an older connection doesn't stand for the new one.
    connection += 1;
    // SCIENT-FORK:END
    publishedRelayConfig = undefined;
    cachedRelayClient = undefined;
    publishConfirmDeadlines.clear();
    heldCompletions.clear();
    yield* Ref.set(publishedStateByThreadRef, new Map());
  });

  const publishThreadUnsafe = Effect.fn("publishThreadUnsafe")(function* (threadId: ThreadId) {
    const publishAgentActivity = yield* readPublishAgentActivityEnabled;
    if (!publishAgentActivity) {
      yield* cancelPublishRetries;
      yield* resetPublishedConnection;
      yield* Effect.logDebug("agent activity publish skipped; publication disabled", {
        threadId,
      });
      return;
    }
    // SCIENT-FORK:START — Scient Accounts: the link and its generation are read together, in the
    // acknowledgement turn, so a relink can't pair the old link with the new generation.
    const captured = yield* linkShare(
      Effect.gen(function* () {
        // SCIENT-FORK:END
        const relayConfig = yield* readRelayConfig;
        if (!relayConfig) {
          yield* cancelPublishRetries;
          yield* resetPublishedConnection;
          return undefined;
        }
        if (
          publishedRelayConfig?.url !== relayConfig.url ||
          publishedRelayConfig.issuer !== relayConfig.issuer ||
          publishedRelayConfig.environmentCredential !== relayConfig.environmentCredential
        ) {
          yield* resetPublishedConnection;
          publishedRelayConfig = relayConfig;
        }
        // SCIENT-FORK:START — Scient Accounts: the link and its generation, read together.
        return { relayConfig, generation: connection };
      }),
    );
    if (captured === undefined) {
      yield* Effect.logDebug("agent activity publish skipped; relay link credentials unavailable", {
        threadId,
      });
      return;
    }
    const { relayConfig, generation } = captured;
    const stale = () => connection !== generation;
    // SCIENT-FORK:END
    const environmentId = yield* serverEnvironment.getEnvironmentId;

    const publishState = Effect.fn("relay.agent_activity.publish")(function* (input: {
      readonly projectId: string | null;
      readonly state: RelayAgentActivityState | null;
      readonly reason: string;
    }) {
      // SCIENT-FORK:START — Scient Accounts: only the current connection keeps its client.
      const relayClient =
        cachedRelayClient !== undefined && !stale()
          ? cachedRelayClient
          : yield* makeRelayClient(relayConfig);
      if (!stale()) cachedRelayClient = relayClient;
      // SCIENT-FORK:END
      const proof = yield* makePublishProof({
        relayIssuer: relayConfig.issuer,
        environmentId,
        threadId,
        state: input.state,
        jti: yield* random.uuidV4(),
      }).pipe(Effect.provideService(EnvironmentSigningKey, signingKey));

      yield* Effect.logInfo("publishing agent activity for thread", {
        environmentId,
        threadId,
        projectId: input.projectId,
        statePhase: input.state?.phase ?? null,
        hasState: input.state !== null,
        reason: input.reason,
      });

      const response = yield* relayClient.server
        .publishAgentActivity({
          params: {
            environmentId,
            threadId,
          },
          payload: {
            state: input.state,
            proof,
          },
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* Effect.logInfo("agent activity publish completed", {
        environmentId,
        threadId,
        ok: response.ok,
        deliveries: deliveryStats(response.deliveries),
      });
    });

    // Read only this thread; full shell reads would make each activity event scale with all threads.
    const threadShell = yield* readAwarenessThread(threadId);
    yield* trackSubagentRequest(threadId, threadShell);
    if (
      threadShell !== null &&
      !isListedThreadLineage(threadShell.lineage) &&
      !hasLivePublishedState(yield* Ref.get(publishedStateByThreadRef), threadId)
    ) {
      // Subagents and side chats have no relay rows to clear; per-event tombstones would needlessly redeliver user aggregates.
      return;
    }
    const thread =
      threadShell === null || threadShell.archivedAt !== null
        ? Option.none<AgentAwarenessThread>()
        : Option.some(threadShell);
    const project = Option.isSome(thread)
      ? yield* projects.getById(thread.value.projectId)
      : Option.none<Project>();
    // SCIENT-FORK:START — Scient Accounts: a code notice is its own row, from Accounts alone.
    const notice = codeNotices.get(threadId);
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    // SCIENT-FORK:END
    const snapshot =
      notice !== undefined
        ? {
            projectId: null,
            state: noticeState(environmentId, notice, nowMs),
            subagentWait: null,
            reason: "snapshot" as const,
          }
        : withAccountRequest(
            resolveAgentAwarenessRelayPublishSnapshot({
              environmentId,
              thread,
              project,
              pendingSubagentRequest: yield* currentSubagentRequestFor(threadId),
            }),
            accountRequests.get(threadId),
            // SCIENT-FORK:START — Scient Accounts: a background sign-in's notice reaches the phone too.
            Option.isNone(thread) && isScientBackgroundThread(threadId)
              ? {
                  environmentId,
                  threadId,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                }
              : undefined,
            // SCIENT-FORK:END
          );
    const publishIdentity = agentAwarenessPublishIdentity(snapshot.state, snapshot.subagentWait);
    const publishedStateByThread = yield* Ref.get(publishedStateByThreadRef);
    if (
      (snapshot.state?.phase === "completed" || snapshot.state?.phase === "failed") &&
      // SCIENT-FORK:START — Scient Accounts: a notice's outcome row is new, never a replay.
      notice === undefined &&
      // SCIENT-FORK:END
      !hasLivePublishedState(publishedStateByThread, threadId)
    ) {
      if (Option.isNone(thread) || !terminalWorkSinceStart(thread.value, startedAt)) return;
    }
    if (
      publishedStateByThread.get(threadId) === publishIdentity &&
      // A held completion settled after an earlier clear still has to alert.
      !(snapshot.state === null && heldCompletions.has(threadId))
    ) {
      // Clear moot deadlines so later transient nulls cannot skip their deferral window.
      publishConfirmDeadlines.delete(threadId);
      heldCompletions.delete(threadId);
      yield* Effect.logDebug("agent activity publish skipped; projected state unchanged", {
        environmentId,
        threadId,
        reason: snapshot.reason,
      });
      return;
    }

    // Confirm tombstones over live state to avoid removing active cards.
    // Confirm completion: a run can end moments before its continuation starts, and the relay
    // alerts on every move into completed.
    const requiresConfirmation = snapshot.state === null || snapshot.state?.phase === "completed";
    if (requiresConfirmation) {
      if (snapshot.state?.phase === "completed") heldCompletions.add(threadId);
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const deadline = publishConfirmDeadlines.get(threadId);
      if (deadline === undefined) {
        publishConfirmDeadlines.set(threadId, nowMs + 5_000);
        yield* Effect.logInfo("agent activity publish deferred pending confirmation", {
          environmentId,
          threadId,
          reason: snapshot.reason,
          statePhase: snapshot.state?.phase ?? null,
          shell: describeThreadShellForAwareness(thread),
        });
        yield* schedulePublishConfirm(threadId);
        return;
      }
      if (nowMs < deadline) {
        return;
      }
      yield* Effect.logInfo("agent activity deferred publish confirmed", {
        environmentId,
        threadId,
        reason: snapshot.reason,
        statePhase: snapshot.state?.phase ?? null,
        shell: describeThreadShellForAwareness(thread),
      });
      // Settled during the hold, not resumed: alert the current completion, then clear the card
      // on a new window. Only settlement may hide it; queued or silent runs also project to null.
      const unsettled =
        snapshot.state === null &&
        heldCompletions.has(threadId) &&
        Option.isSome(thread) &&
        thread.value.settledOverride === "settled"
          ? resolveAgentAwarenessRelayPublishSnapshot({
              environmentId,
              thread: Option.some({ ...thread.value, settledOverride: null }),
              project,
              pendingSubagentRequest: null,
            })
          : null;
      if (unsettled?.state?.phase === "completed") {
        const completion = unsettled.state;
        yield* publishState({
          projectId: unsettled.projectId,
          state: completion,
          reason: unsettled.reason,
        }).pipe(withRelayClientTracing);
        // SCIENT-FORK:START — Scient Accounts: a publish begun on an older connection goes again.
        if (stale()) return yield* publishAgain(threadId);
        // SCIENT-FORK:END
        heldCompletions.delete(threadId);
        publishConfirmDeadlines.set(threadId, nowMs + 5_000);
        yield* Ref.update(publishedStateByThreadRef, (publishedStates) =>
          new Map(publishedStates).set(threadId, agentAwarenessPublishIdentity(completion)),
        );
        yield* schedulePublishConfirm(threadId);
        return;
      }
    } else {
      publishConfirmDeadlines.delete(threadId);
      heldCompletions.delete(threadId);
    }

    if (snapshot.reason === "thread-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; thread not found", {
        environmentId,
        threadId,
      });
    } else if (snapshot.reason === "project-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; project not found", {
        environmentId,
        threadId,
        projectId: snapshot.projectId,
      });
    }

    const childRequestId = snapshot.subagentWait?.requestId;
    const childAlert = childAlertByThread.get(threadId);
    const state =
      snapshot.state !== null &&
      childRequestId !== undefined &&
      childAlert?.requestId === childRequestId
        ? { ...snapshot.state, updatedAt: childAlert.updatedAt }
        : snapshot.state;
    yield* publishState({
      projectId: snapshot.projectId,
      state,
      reason: snapshot.reason,
    }).pipe(withRelayClientTracing);
    // SCIENT-FORK:START — Scient Accounts: the notice reached the relay, which takes it to the phone;
    // once its time is up and it is off the phone, Accounts lets it go. Reached an older
    // connection only, it goes again on the new one, with nothing recorded or acknowledged.
    if (stale()) return yield* publishAgain(threadId);
    // Acknowledged off the queue, so a busy Accounts holds no publish: each try is bounded and
    // retried, and none outlives the link it is for.
    if (notice !== undefined && Option.isSome(accounts)) {
      const account = accounts.value;
      const ack =
        notice.role === "notice" && state?.phase === "waiting_for_approval"
          ? () => account.codeNoticeDelivered(notice.notice.noticeId, () => !stale())
          : state === null && nowMs - Date.parse(notice.notice.at) >= NOTICE_ROW_MS
            ? () => account.codeNoticeCleared(notice.notice.noticeId, notice.role, () => !stale())
            : undefined;
      if (ack !== undefined) yield* acknowledge(ack, stale, threadId);
    }
    // SCIENT-FORK:END
    if (state !== null && childRequestId !== undefined) {
      childAlertByThread.set(threadId, { requestId: childRequestId, updatedAt: state.updatedAt });
    }
    publishConfirmDeadlines.delete(threadId);
    heldCompletions.delete(threadId);
    // SCIENT-FORK:START — Scient Accounts: recorded only while its connection is still the current one.
    yield* Ref.update(publishedStateByThreadRef, (publishedStates) =>
      stale() ? publishedStates : new Map(publishedStates).set(threadId, publishIdentity),
    );
    // SCIENT-FORK:END
  });

  const readAwarenessThread = (threadId: ThreadId) =>
    threads
      .getAgentAwarenessSnapshot(threadId)
      .pipe(Effect.map((snapshot) => snapshot.threads[0] ?? null));

  // The subagent helpers below are untraced: they run per event inside
  // publishThreadUnsafe, whose span already covers them.
  const findTopLevelThreadId = Effect.fnUntraced(function* (child: AgentAwarenessThread) {
    const seen = new Set<ThreadId>([child.id]);
    let current: AgentAwarenessThread | null = child;
    while (
      current?.lineage.relationshipToParent === "subagent" ||
      current?.lineage.sideChat === true
    ) {
      const parentId: ThreadId | null = current.lineage.parentThreadId;
      if (parentId === null || seen.has(parentId)) return null;
      seen.add(parentId);
      current = yield* readAwarenessThread(parentId);
    }
    return current?.id ?? null;
  });

  const trackSubagentRequest = Effect.fnUntraced(function* (
    threadId: ThreadId,
    threadShell: AgentAwarenessThread | null,
  ) {
    const requestId = waitingApprovalId(threadShell);
    const previous = subagentRequests.get(threadId);
    // An unchanged wait still republishes its parent: a relink catch-up reaches it only here.
    if (threadShell === null || requestId === undefined) {
      if (previous === undefined) return;
      subagentRequests.delete(threadId);
      yield* enqueueTopLevelPublish(previous.topLevelThreadId);
      return;
    }
    const topLevelThreadId =
      previous?.topLevelThreadId ?? (yield* findTopLevelThreadId(threadShell));
    if (topLevelThreadId === null) return;
    subagentRequests.set(threadId, { topLevelThreadId, requestId });
    yield* enqueueTopLevelPublish(topLevelThreadId);
  });

  // The map can miss a child's update while publishing is off or the relay is
  // unlinked, so each waiting child is re-read before its parent is published.
  const currentSubagentRequestFor = Effect.fnUntraced(function* (topLevelThreadId: ThreadId) {
    let pending: SubagentRequestAwareness | null = null;
    for (const [childId, entry] of subagentRequests) {
      if (entry.topLevelThreadId !== topLevelThreadId) continue;
      const child = yield* readAwarenessThread(childId);
      const requestId = waitingApprovalId(child);
      if (child === null || requestId === undefined) {
        subagentRequests.delete(childId);
        continue;
      }
      if (requestId !== entry.requestId) subagentRequests.set(childId, { ...entry, requestId });
      // The newest wait is the one to announce.
      if (pending === null || DateTime.isGreaterThan(child.updatedAt, pending.updatedAt)) {
        pending = {
          requestId,
          updatedAt: child.updatedAt,
          waitsForInput: child.pendingRuntimeRequest?.kind === "user_input",
        };
      }
    }
    return pending;
  });

  const processThreadPublish = Effect.fnUntraced(function* (threadId: ThreadId) {
    const retry = publishRetries.get(threadId);
    if (retry?.timer !== undefined) {
      const timer = retry.timer;
      retry.timer = undefined;
      yield* Fiber.interrupt(timer);
    }
    yield* publishThreadUnsafe(threadId).pipe(
      Effect.tap(() => cancelPublishRetry(threadId)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        return Effect.logWarning("agent activity publish failed", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(schedulePublishRetry(threadId)));
      }),
      Effect.withSpan("AgentAwarenessRelay.publishThread"),
    );
  });

  const worker = yield* makeAgentAwarenessPublishWorker(processThreadPublish);
  const enqueueThreadPublish = (threadId: ThreadId) =>
    cancelPublishRetry(threadId).pipe(Effect.andThen(worker.enqueue(threadId)));
  enqueueTopLevelPublish = enqueueThreadPublish;
  // SCIENT-FORK:START — Scient Accounts: a sign-in waiting for the user reaches their phone.
  /** Notice rows have a queue of their own: other threads' backlog never delays them. */
  const noticeWorker = yield* makeAgentAwarenessPublishWorker(processThreadPublish);
  const publishNoticeRow = (threadId: ThreadId) => noticeWorker.enqueue(threadId);
  /** A notice row's retries and confirmations stay on its queue. */
  const queueFor = (threadId: ThreadId) => (codeNotices.has(threadId) ? noticeWorker : worker);
  publishAgain = (threadId) => queueFor(threadId).enqueue(threadId);
  const onAccounts = Effect.fnUntraced(function* (snapshot: AccountsSnapshot) {
    const previous = accountRequests;
    // A background thread's code notice reaches the phone as its own row, once.
    accountRequests = accountRequestsByThread({
      ...snapshot,
      needsYou: (snapshot.needsYou ?? []).filter(
        (need) => !(isScientBackgroundThread(need.threadId ?? "") && isCodeNotice(need.detail)),
      ),
    });
    const previousNotices = codeNotices;
    codeNotices = new Map(
      (snapshot.codeNotices ?? []).flatMap((notice): Array<readonly [string, NoticeRow]> => [
        [noticeThread(notice.noticeId), { notice, role: "notice" }],
        [settledThread(notice.noticeId), { notice, role: "settled" }],
      ]),
    );
    const changedRequests = [...new Set([...previous.keys(), ...accountRequests.keys()])].filter(
      (threadId) => previous.get(threadId) !== accountRequests.get(threadId),
    );
    const changedNotices = [...new Set([...previousNotices.keys(), ...codeNotices.keys()])].filter(
      (threadId) =>
        JSON.stringify(previousNotices.get(threadId)?.notice) !==
        JSON.stringify(codeNotices.get(threadId)?.notice),
    );
    yield* Effect.forEach(
      changedRequests,
      (threadId) => enqueueThreadPublish(ThreadId.make(threadId)),
      {
        discard: true,
      },
    );
    yield* Effect.forEach(changedNotices, (threadId) => publishNoticeRow(ThreadId.make(threadId)), {
      discard: true,
    });
    // Each notice's time runs out once, here or after a restart: both rows go, then Accounts
    // lets the notice go.
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    for (const notice of snapshot.codeNotices ?? []) {
      if (retiring.has(notice.noticeId)) continue;
      retiring.add(notice.noticeId);
      const left = Math.max(0, Date.parse(notice.at) + NOTICE_ROW_MS - nowMs);
      yield* Effect.sleep(left).pipe(
        Effect.andThen(publishNoticeRow(settledThread(notice.noticeId))),
        Effect.andThen(publishNoticeRow(noticeThread(notice.noticeId))),
        Effect.forkIn(scope),
      );
    }
  });
  if (Option.isSome(accounts))
    // What stands now first, so a restart settles rows it last published, then each change.
    yield* Stream.concat(
      Stream.fromEffect(accounts.value.snapshot).pipe(Stream.catch(() => Stream.empty)),
      accounts.value.changes,
    ).pipe(Stream.runForEach(onAccounts), Effect.forkIn(scope));
  // SCIENT-FORK:END
  const publishThread: AgentAwarenessRelay["Service"]["publishThread"] = (threadId) =>
    enqueueThreadPublish(threadId).pipe(Effect.andThen(worker.drain));

  schedulePublishRetry = Effect.fnUntraced(function* (threadId: ThreadId) {
    const attempts = publishRetries.get(threadId)?.attempts ?? 0;
    const delayMs =
      RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS[attempts] ?? RELAY_AGENT_ACTIVITY_STEADY_RETRY_DELAY_MS;
    if (attempts === RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS.length) {
      yield* Effect.logWarning(
        "agent activity publish retry budget exhausted; retrying every minute",
        {
          threadId,
        },
      );
    }
    const retry = {
      attempts: attempts + 1,
      timer: undefined as Fiber.Fiber<void> | undefined,
    };
    publishRetries.set(threadId, retry);
    const timer = yield* Effect.sleep(delayMs).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (publishRetries.get(threadId) !== retry) return Effect.void;
          retry.timer = undefined;
          // SCIENT-FORK:START — Scient Accounts: a notice row retries on its own queue.
          return queueFor(threadId).enqueue(threadId);
          // SCIENT-FORK:END
        }),
      ),
      Effect.forkIn(scope),
    );
    if (publishRetries.get(threadId) !== retry) {
      yield* Fiber.interrupt(timer);
    } else {
      retry.timer = timer;
    }
  });

  const publishActiveThreadsUnsafe = Effect.gen(function* () {
    const relayUrl = yield* readSecretString(RELAY_URL_SECRET).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!relayUrl) {
      yield* Effect.logDebug("agent activity snapshot skipped; relay link credentials unavailable");
      return "unlinked" as const;
    }
    const publishAgentActivity = yield* readPublishAgentActivityEnabled.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!publishAgentActivity) {
      yield* Effect.logDebug("agent activity snapshot skipped; publication disabled");
      return "disabled" as const;
    }
    const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
    if (!relayConfig) {
      yield* Effect.logDebug("agent activity snapshot skipped; relay link credentials unavailable");
      return "unlinked" as const;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const projectSnapshot = yield* projects.snapshot;
    const activitySnapshot = yield* threads.getAgentAwarenessSnapshot();
    // Live children aren't listed, but a waiting one makes its top-level thread wait.
    const liveChildren = yield* Effect.forEach(
      (yield* threads.listActiveShellIndex()).filter(
        (thread) => thread.lineage.relationshipToParent === "subagent" && thread.mayBeLive,
      ),
      (thread) => readAwarenessThread(thread.id),
    );
    const activeThreadIds = resolveAgentAwarenessRelayActiveThreadIds({
      environmentId,
      startedAt,
      projects: projectSnapshot.projects,
      threads: [...activitySnapshot.threads, ...liveChildren.filter((thread) => thread !== null)],
    });
    // SCIENT-FORK:START — Scient Accounts: a link or relink republishes every notice row standing.
    yield* Effect.forEach(
      [...codeNotices.keys()],
      (threadId) => publishNoticeRow(ThreadId.make(threadId)),
      { discard: true },
    );
    // SCIENT-FORK:END
    if (activeThreadIds.length === 0) {
      yield* Effect.logDebug("agent activity snapshot has no publishable threads");
      return "published" as const;
    }
    yield* Effect.logInfo("publishing active agent activity snapshot", {
      count: activeThreadIds.length,
    });
    yield* Effect.forEach(activeThreadIds, enqueueThreadPublish, { discard: true });
    yield* worker.drain;
    return "published" as const;
  });

  // Many environments never link, so while unlinked the retry backs off from 5
  // s to 60 s. A linked environment keeps the 5 s retry, because `t3 connect
  // publish` can turn publishing on from another process. Keep this untraced:
  // an unlinked environment can retry for the lifetime of the process.
  const publishActiveThreadsWhenConfigured = Effect.fnUntraced(function* (
    logEnabledWhenReady: boolean,
  ) {
    let unlinkedRetryDelayMs = 5_000;
    while (true) {
      const result = yield* publishActiveThreadsUnsafe.pipe(
        Effect.orElseSucceed(() => "failed" as const),
      );
      if (result === "published") {
        if (logEnabledWhenReady) {
          const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
          yield* Effect.logInfo("agent activity publishing enabled after link reconciliation", {
            relayUrl: relayConfig?.url,
          });
        }
        logEnabledWhenReady = false;
        unlinkedRetryDelayMs = 5_000;
        yield* Queue.take(catchUpRequests);
        continue;
      }
      const retryDelayMs = result === "unlinked" ? unlinkedRetryDelayMs : 5_000;
      yield* Effect.race(Effect.sleep(retryDelayMs), Queue.take(catchUpRequests));
      if (result === "unlinked") {
        unlinkedRetryDelayMs = Math.min(unlinkedRetryDelayMs * 2, 60_000);
      }
    }
  });

  schedulePublishConfirm = (threadId) =>
    Effect.forkIn(
      Effect.sleep("5 seconds").pipe(
        // SCIENT-FORK:START — Scient Accounts: a notice row confirms on its own queue.
        Effect.andThen(queueFor(threadId).enqueue(threadId)),
        // SCIENT-FORK:END
        Effect.catchCause((cause) =>
          Effect.logWarning("deferred agent activity confirmation failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
      scope,
    ).pipe(Effect.asVoid);

  const start: AgentAwarenessRelay["Service"]["start"] = Effect.fn("AgentAwarenessRelay.start")(
    function* () {
      const [relayConfig, publishEnabled] = yield* Effect.all([
        readRelayConfig.pipe(Effect.orElseSucceed(() => null)),
        readPublishAgentActivityEnabled.pipe(Effect.orElseSucceed(() => false)),
      ]);
      const startupState = resolveAgentActivityPublishingStartupState({
        relayConfigured: relayConfig !== null,
        publishEnabled,
      });
      switch (startupState) {
        case "waiting-for-link":
          yield* Effect.logInfo(
            "agent activity publishing standby; waiting for Scient Connect link reconciliation",
          );
          break;
        case "disabled":
          yield* Effect.logInfo(
            "agent activity publishing disabled by Scient Connect configuration",
          );
          break;
        case "enabled":
          yield* Effect.logInfo("agent activity publishing enabled", {
            relayUrl: relayConfig?.url,
          });
          break;
      }
      yield* forkParked(
        Effect.sleep("1 second").pipe(
          Effect.andThen(publishActiveThreadsWhenConfigured(startupState !== "enabled")),
        ),
      );
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) => {
          const threadId = eventThreadId(event);
          if (!shouldPublishAgentAwarenessEvent(event)) {
            return Effect.void;
          }
          return Effect.logDebug("agent activity publishing queued thread publish", {
            eventType: event.type,
            threadId,
          }).pipe(Effect.andThen(enqueueThreadPublish(threadId)));
        }),
      );
    },
  );

  return AgentAwarenessRelay.of({
    publishThread,
    drain: worker.drain.pipe(Effect.andThen(noticeWorker.drain)),
    // SCIENT-FORK:START — Scient Accounts: a link change waits for a notice acknowledgement's commit.
    replacingLink: Effect.fn("AgentAwarenessRelay.replacingLink")(function* <A, E, R>(
      change: Effect.Effect<A, E, R>,
    ) {
      return yield* linkChange(change.pipe(Effect.ensuring(resetPublishedConnection)));
    }),
    // SCIENT-FORK:END
    requestCatchUp: Effect.fn("AgentAwarenessRelay.requestCatchUp")(function () {
      // SCIENT-FORK:START — Scient Accounts: a new link's commit ends the old connection at once,
      // so an answer from it that comes later stands for nothing.
      return readRelayConfig.pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((link) =>
          publishedRelayConfig !== undefined &&
          (link?.url !== publishedRelayConfig.url ||
            link.issuer !== publishedRelayConfig.issuer ||
            link.environmentCredential !== publishedRelayConfig.environmentCredential)
            ? resetPublishedConnection
            : Effect.void,
        ),
        linkChange,
        Effect.andThen(Queue.offer(catchUpRequests, undefined)),
        // SCIENT-FORK:END
        // SCIENT-FORK:START — Scient Accounts: notice rows reconcile on their own queue, whatever
        // holds the chats' catch-up.
        Effect.andThen(
          Effect.suspend(() =>
            Effect.forEach([...codeNotices.keys()], (id) => publishNoticeRow(ThreadId.make(id)), {
              discard: true,
            }),
          ),
        ),
        // SCIENT-FORK:END
        Effect.asVoid,
      );
    }),
    start,
  });
});

export const layer = Layer.effect(AgentAwarenessRelay, make);
