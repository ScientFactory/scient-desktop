// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off -- Dedicated Scient analytics worker.
import * as NodeCrypto from "node:crypto";
import type * as NodeWorkerThreads from "node:worker_threads";

import {
  ANALYTICS_SCHEMA_VERSION,
  ANALYTICS_SOURCE,
  type AnalyticsBatch,
  type AnalyticsEvent,
} from "./contract.ts";
import { AnalyticsOutbox, type PendingAnalyticsEvent } from "./outbox.ts";
import {
  FLUSH_DEADLINE_MS,
  SEND_DEADLINE_MS,
  type AnalyticsWorkerCommand,
  type AnalyticsWorkerInput,
  type AnalyticsWorkerResponse,
} from "./workerProtocol.ts";

const BATCH_SIZE = 50;
// Ten batches per 30 s flush stays well under the gateway's 120 requests a minute.
const MAX_BATCHES_PER_FLUSH = 10;
const FLUSH_INTERVAL_MS = 30_000;
const TRANSPORT_BACKOFF_BASE_MS = 30_000;
const TRANSPORT_BACKOFF_MAX_MS = 15 * 60 * 1_000;
const RETRY_AFTER_MAX_MS = 60 * 60 * 1_000;
const REJECTION_RETRY_MAX_MS = 30 * 60 * 1_000;
const MAX_ACKNOWLEDGEMENT_BYTES = 1_024;

async function acknowledgement(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new DeliveryFailure("invalid-acknowledgement");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    // Read errors propagate: a reset or deadline mid-body is a transport failure, not a bad reply.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ACKNOWLEDGEMENT_BYTES) {
        throw new DeliveryFailure("invalid-acknowledgement");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value;
  } catch {
    throw new DeliveryFailure("invalid-acknowledgement");
  }
}

function acceptedValue(value: unknown): unknown {
  return typeof value === "object" && value !== null && "accepted" in value
    ? value.accepted
    : undefined;
}

// @effect-diagnostics-next-line extendsNativeError:off - this worker loads no Effect runtime; DeliveryFailure is a local throw sentinel.
class DeliveryFailure extends Error {
  readonly errorClass: string;

  constructor(errorClass: string) {
    super(errorClass);
    this.errorClass = errorClass;
  }
}

/** Retry-After as delta seconds or an HTTP date. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

// 408, 429 and 5xx say nothing about the events; other refusals point at them.
const isTransportStatus = (status: number) => status === 408 || status === 429 || status >= 500;

type DeliveryOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "aborted" }
  | {
      readonly kind: "transport";
      // Diagnostics keep their meaning: `rejected` is any error reply, retryable or not.
      readonly deliveryClass: "timeout" | "network" | "rejected";
      readonly errorClass: string;
      readonly retryAfterMs?: number | undefined;
    }
  | { readonly kind: "rejected"; readonly errorClass: string };

export function startAnalyticsWorker(
  input: AnalyticsWorkerInput & {
    readonly port: NodeWorkerThreads.MessagePort;
  },
): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort postMessage has no targetOrigin parameter.
  const post = (response: AnalyticsWorkerResponse) => input.port.postMessage(response);
  let outbox: AnalyticsOutbox;

  try {
    outbox = new AnalyticsOutbox(input.outboxPath);
  } catch {
    post({ type: "fatal", errorClass: "initialization" });
    input.port.close();
    return;
  }

  const ensureInstallationIdentity = () => {
    let id = outbox.readMeta("installation_id");
    if (!id) {
      id = `installation:${NodeCrypto.randomUUID()}`;
      outbox.writeMeta("installation_id", id);
    }
    let token = outbox.readMeta("installation_token");
    if (!token) {
      token = NodeCrypto.randomBytes(32).toString("hex");
      outbox.writeMeta("installation_token", token);
    }
    return { id, token } as const;
  };
  let installation: ReturnType<typeof ensureInstallationIdentity>;
  try {
    installation = ensureInstallationIdentity();
  } catch {
    outbox.close();
    post({ type: "fatal", errorClass: "initialization" });
    input.port.close();
    return;
  }

  let closed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<number> | null = null;
  let activeAbortController: AbortController | null = null;
  let lastDiagnosticsAt = 0;
  // Backoff belongs to the endpoint: one failed send must not park the events it carried.
  let transportFailures = 0;
  let transportRetryAt = 0;

  const stopScheduledFlush = () => {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const canDeliver = () => !closed;

  const scheduleFlush = () => {
    if (!canDeliver() || flushTimer !== null || outbox.size() === 0) return;
    flushTimer = setTimeout(
      () => {
        flushTimer = null;
        void flush().catch(failRuntime);
      },
      Math.max(FLUSH_INTERVAL_MS, transportRetryAt - Date.now()),
    );
    flushTimer.unref();
  };

  const noteTransportFailure = (retryAfter: number | undefined) => {
    transportFailures += 1;
    const backoff = Math.min(
      TRANSPORT_BACKOFF_MAX_MS,
      TRANSPORT_BACKOFF_BASE_MS * 2 ** Math.min(transportFailures - 1, 10),
    );
    const jittered = backoff * (0.8 + Math.random() * 0.4);
    const delay = Math.max(jittered, Math.min(retryAfter ?? 0, RETRY_AFTER_MAX_MS));
    transportRetryAt = Date.now() + delay;
  };

  const deliver = async (
    events: ReadonlyArray<PendingAnalyticsEvent>,
  ): Promise<DeliveryOutcome> => {
    const batch: AnalyticsBatch = {
      schema_version: ANALYTICS_SCHEMA_VERSION,
      source: ANALYTICS_SOURCE,
      events: events.map(
        ({
          attemptCount: _attemptCount,
          rejectionCount: _rejectionCount,
          priority: _priority,
          ...event
        }) => event,
      ),
    };
    const controller = new AbortController();
    activeAbortController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SEND_DEADLINE_MS);
    timeout.unref();
    try {
      const response = await fetch(input.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Scient-Installation-Token": installation.token,
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const errorClass = `http-${response.status}`;
        if (!isTransportStatus(response.status)) return { kind: "rejected", errorClass };
        return {
          kind: "transport",
          deliveryClass: "rejected",
          errorClass,
          retryAfterMs:
            response.status === 429 || response.status === 503
              ? retryAfterMs(response.headers.get("retry-after"), Date.now())
              : undefined,
        };
      }
      if (acceptedValue(await acknowledgement(response)) !== events.length) {
        throw new DeliveryFailure("invalid-acknowledgement");
      }
      return { kind: "delivered" };
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return { kind: "aborted" };
      if (timedOut) return { kind: "transport", deliveryClass: "timeout", errorClass: "timeout" };
      if (error instanceof DeliveryFailure)
        return { kind: "rejected", errorClass: error.errorClass };
      return { kind: "transport", deliveryClass: "network", errorClass: "network" };
    } finally {
      clearTimeout(timeout);
      if (activeAbortController === controller) activeAbortController = null;
    }
  };

  const recordOutcome = (
    events: ReadonlyArray<PendingAnalyticsEvent>,
    outcome: Exclude<DeliveryOutcome, { readonly kind: "aborted" }>,
  ) => {
    const ids = events.map((event) => event.id);
    switch (outcome.kind) {
      case "delivered":
        outbox.remove(ids);
        break;
      case "transport":
        outbox.markAttempted(ids, outcome.errorClass);
        noteTransportFailure(outcome.retryAfterMs);
        return;
      case "rejected": {
        const rejections = Math.max(...events.map((event) => event.rejectionCount)) + 1;
        outbox.markRejected(
          ids,
          outcome.errorClass,
          Date.now() + Math.min(REJECTION_RETRY_MAX_MS, 5_000 * 2 ** Math.min(rejections - 1, 8)),
        );
        break;
      }
    }
    // Any reply from the gateway shows the path to it works again.
    transportFailures = 0;
    transportRetryAt = 0;
  };

  const reportDiagnostics = (
    events: ReadonlyArray<PendingAnalyticsEvent>,
    outcome: Exclude<DeliveryOutcome, { readonly kind: "aborted" }>,
  ) => {
    const timestamp = Date.now();
    if (
      !canDeliver() ||
      timestamp - lastDiagnosticsAt < 60_000 ||
      // Do not report diagnostic-only delivery: that would perpetuate its own queue.
      !events.some((event) => event.name !== "app.diagnostics")
    ) {
      return;
    }
    lastDiagnosticsAt = timestamp;
    const oldest = Math.min(...events.map((event) => Date.parse(event.occurred_at)));
    post({
      type: "diagnostics",
      queuedCount: outbox.size(),
      droppedCount: outbox.takeDroppedCount(),
      retryCount: Math.max(...events.map((event) => event.attemptCount)),
      // An outage shows as delayed delivery, not as missing events.
      oldestEventAgeMs: Number.isFinite(oldest) ? Math.max(0, timestamp - oldest) : -1,
      deliveryClass: outcome.kind === "transport" ? outcome.deliveryClass : outcome.kind,
    });
  };

  const flush = (): Promise<number> => {
    if (!canDeliver()) return Promise.resolve(0);
    if (activeFlush !== null) return activeFlush;

    const operation = (async () => {
      let delivered = 0;
      const started = Date.now();
      // Re-check between batches so close takes over at once, and start
      // another upload only while its whole deadline fits in the flush's budget.
      for (
        let batches = 0;
        batches < MAX_BATCHES_PER_FLUSH &&
        canDeliver() &&
        Date.now() >= transportRetryAt &&
        (batches === 0 || Date.now() - started + SEND_DEADLINE_MS <= FLUSH_DEADLINE_MS);
        batches += 1
      ) {
        const events = outbox.pending(BATCH_SIZE, Date.now());
        if (events.length === 0) break;
        const outcome = await deliver(events);
        if (outcome.kind === "aborted") break;
        recordOutcome(events, outcome);
        reportDiagnostics(events, outcome);
        if (outcome.kind !== "delivered") break;
        delivered += events.length;
      }
      return delivered;
    })();

    activeFlush = operation.finally(() => {
      activeFlush = null;
      scheduleFlush();
    });
    return activeFlush;
  };

  const failRuntime = () => {
    if (closed) return;
    closed = true;
    stopScheduledFlush();
    activeAbortController?.abort();
    try {
      outbox.close();
    } catch {
      // The worker is already failing; never leak local exception details.
    }
    post({ type: "fatal", errorClass: "runtime" });
    input.port.close();
  };

  input.port.on("message", (command: AnalyticsWorkerCommand) => {
    if (closed && command.type !== "close") return;
    try {
      switch (command.type) {
        case "enqueue": {
          const events: AnalyticsEvent[] = command.events.map(
            ({ priority: _priority, ...event }) => ({ ...event, distinct_id: installation.id }),
          );
          const accepted = outbox.enqueueBatch(
            events,
            command.events.map((event) => event.priority),
          );
          post({ type: "persisted", batchId: command.batchId, accepted });
          scheduleFlush();
          return;
        }
        case "flush": {
          void flush()
            .then((value) => post({ type: "result", requestId: command.requestId, value }))
            .catch(failRuntime);
          return;
        }
        case "pending-count": {
          post({ type: "result", requestId: command.requestId, value: outbox.size() });
          return;
        }
        case "close": {
          closed = true;
          stopScheduledFlush();
          activeAbortController?.abort();
          void Promise.resolve(activeFlush)
            .then(() => {
              outbox.close();
              post({ type: "result", requestId: command.requestId, value: 0 });
              input.port.close();
            })
            .catch(() => input.port.close());
          return;
        }
      }
    } catch {
      failRuntime();
    }
  });

  input.port.start();
  post({ type: "ready" });
  scheduleFlush();
}
