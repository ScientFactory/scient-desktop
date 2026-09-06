// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off -- Dedicated Scient analytics worker.
import * as NodeCrypto from "node:crypto";
import type * as NodeWorkerThreads from "node:worker_threads";

import {
  ANALYTICS_SCHEMA_VERSION,
  ANALYTICS_SOURCE,
  consentAllows,
  type AnalyticsBatch,
  type AnalyticsEvent,
} from "./contract.ts";
import { AnalyticsOutbox } from "./outbox.ts";
import type {
  AnalyticsWorkerCommand,
  AnalyticsWorkerInput,
  AnalyticsWorkerResponse,
} from "./workerProtocol.ts";

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RETRY_MS = 30 * 60 * 1_000;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_ACKNOWLEDGEMENT_BYTES = 1_024;

async function acknowledgement(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new DeliveryFailure("invalid-acknowledgement");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ACKNOWLEDGEMENT_BYTES) {
        throw new DeliveryFailure("invalid-acknowledgement");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value;
  } catch {
    throw new DeliveryFailure("invalid-acknowledgement");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function acceptedValue(value: unknown): unknown {
  return typeof value === "object" && value !== null && "accepted" in value
    ? value.accepted
    : undefined;
}

class DeliveryFailure extends Error {
  readonly errorClass: string;

  constructor(errorClass: string) {
    super(errorClass);
    this.errorClass = errorClass;
  }
}

function deliveryErrorClass(error: unknown): string {
  if (error instanceof DeliveryFailure) return error.errorClass;
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "network";
}

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
    if (input.purpose === "collection") outbox.purgeAbove(input.consent);
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
  let consent = input.consent;
  let controlsPending = 0;
  let controlQueue: Promise<void> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let activeFlush: Promise<number> | null = null;
  let activeAbortController: AbortController | null = null;
  let lastDiagnosticsAt = 0;

  const stopScheduledFlush = () => {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const canDeliver = () =>
    !closed && controlsPending === 0 && consent !== "off" && input.purpose === "collection";

  const scheduleFlush = () => {
    if (!canDeliver() || flushTimer !== null || outbox.size() === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch(failRuntime);
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref();
  };

  const flush = (): Promise<number> => {
    if (!canDeliver()) return Promise.resolve(0);
    if (activeFlush !== null) return activeFlush;

    const operation = (async () => {
      const events = outbox.pending(BATCH_SIZE, Date.now());
      if (events.length === 0) return 0;
      const batch: AnalyticsBatch = {
        schema_version: ANALYTICS_SCHEMA_VERSION,
        source: ANALYTICS_SOURCE,
        events: events.map(
          ({ attemptCount: _attemptCount, priority: _priority, ...event }) => event,
        ),
      };

      const controller = new AbortController();
      let deliveryClass: "delivered" | "timeout" | "network" | "rejected" = "delivered";
      activeAbortController = controller;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
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
        if (!response.ok) throw new DeliveryFailure(`http-${response.status}`);
        if (acceptedValue(await acknowledgement(response)) !== events.length) {
          throw new DeliveryFailure("invalid-acknowledgement");
        }
        outbox.remove(events.map((event) => event.id));
        return events.length;
      } catch (error) {
        if (controller.signal.aborted && !timedOut) return 0;
        deliveryClass = timedOut
          ? "timeout"
          : error instanceof DeliveryFailure
            ? "rejected"
            : "network";
        const attempt = Math.max(...events.map((event) => event.attemptCount)) + 1;
        const retryDelay = Math.min(MAX_RETRY_MS, 5_000 * 2 ** Math.min(attempt - 1, 8));
        outbox.markFailed(
          events.map((event) => event.id),
          timedOut ? "timeout" : deliveryErrorClass(error),
          Date.now() + retryDelay,
        );
        return 0;
      } finally {
        clearTimeout(timeout);
        activeAbortController = null;
        const timestamp = Date.now();
        if (
          canDeliver() &&
          consentAllows(consent, "diagnostic") &&
          timestamp - lastDiagnosticsAt >= 60_000 &&
          events.some((event) => event.name !== "app.diagnostics")
        ) {
          lastDiagnosticsAt = timestamp;
          // Do not report diagnostic-only delivery: that would perpetuate its own queue.
          post({
            type: "diagnostics",
            queuedCount: outbox.size(),
            retryCount: Math.max(...events.map((event) => event.attemptCount)),
            deliveryClass,
          });
        }
      }
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

  const control = (requestId: number, operation: () => Promise<number>) => {
    controlsPending += 1;
    stopScheduledFlush();
    activeAbortController?.abort();
    controlQueue = controlQueue
      .then(async () => {
        await activeFlush;
        if (closed) return;
        const value = await operation();
        post({ type: "result", requestId, value });
      })
      .catch(failRuntime)
      .finally(() => {
        controlsPending -= 1;
        scheduleFlush();
      });
  };

  input.port.on("message", (command: AnalyticsWorkerCommand) => {
    if (closed && command.type !== "close") return;
    try {
      switch (command.type) {
        case "enqueue": {
          const allowed =
            input.purpose === "collection"
              ? command.events.filter((event) => consentAllows(consent, event.privacy_level))
              : [];
          const events: AnalyticsEvent[] = allowed.map(({ priority: _priority, ...event }) => ({
            ...event,
            distinct_id: installation.id,
            consent_level:
              consent !== "off" && !consentAllows(consent, event.consent_level)
                ? consent
                : event.consent_level,
          }));
          const accepted = outbox.enqueueBatch(
            events,
            allowed.map((event) => event.priority),
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
        case "set-consent": {
          consent = command.consent;
          control(command.requestId, async () => outbox.purgeAbove(command.consent));
          return;
        }
        case "pending-count": {
          post({ type: "result", requestId: command.requestId, value: outbox.size() });
          return;
        }
        case "delete-data": {
          const deletionUrl = new URL("/v1/installations/delete", input.endpoint);
          control(command.requestId, async () => {
            try {
              const response = await fetch(deletionUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Scient-Installation-Token": installation.token,
                },
                body: JSON.stringify({ schema_version: 1, installation_id: installation.id }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                redirect: "error",
              });
              if (!response.ok) return 0;
              if (acceptedValue(await acknowledgement(response)) !== true) return 0;
              outbox.reset();
              installation = ensureInstallationIdentity();
              return 1;
            } catch {
              return 0;
            }
          });
          return;
        }
        case "close": {
          closed = true;
          stopScheduledFlush();
          activeAbortController?.abort();
          void Promise.all([activeFlush, controlQueue])
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
