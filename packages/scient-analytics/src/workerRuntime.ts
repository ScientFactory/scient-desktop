// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off -- Dedicated Scient analytics worker.
import * as NodeCrypto from "node:crypto";
import type * as NodeWorkerThreads from "node:worker_threads";

import {
  ANALYTICS_SCHEMA_VERSION,
  ANALYTICS_SOURCE,
  type AnalyticsBatch,
  type AnalyticsEvent,
} from "./contract.ts";
import { AnalyticsOutbox } from "./outbox.ts";
import type { AnalyticsWorkerCommand, AnalyticsWorkerResponse } from "./workerProtocol.ts";

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RETRY_MS = 30 * 60 * 1_000;

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

export function startAnalyticsWorker(input: {
  readonly port: NodeWorkerThreads.MessagePort;
  readonly outboxPath: string;
  readonly endpoint: string;
}): void {
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

  let installationId = outbox.readMeta("installation_id");
  if (!installationId) {
    installationId = `installation:${NodeCrypto.randomUUID()}`;
    outbox.writeMeta("installation_id", installationId);
  }
  let installationToken = outbox.readMeta("installation_token");
  if (!installationToken) {
    installationToken = NodeCrypto.randomBytes(32).toString("hex");
    outbox.writeMeta("installation_token", installationToken);
  }

  let closed = false;
  let activeFlush: Promise<number> | null = null;
  let activeAbortController: AbortController | null = null;

  const flush = (): Promise<number> => {
    if (closed) return Promise.resolve(0);
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
      activeAbortController = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      timeout.unref();
      try {
        const response = await fetch(input.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Scient-Installation-Token": installationToken,
          },
          body: JSON.stringify(batch),
          signal: controller.signal,
        });
        if (!response.ok) throw new DeliveryFailure(`http-${response.status}`);
        const body = (await response.json().catch(() => {
          throw new DeliveryFailure("invalid-acknowledgement");
        })) as { readonly accepted?: unknown };
        if (body.accepted !== events.length) {
          throw new DeliveryFailure("invalid-acknowledgement");
        }
        outbox.remove(events.map((event) => event.id));
        return events.length;
      } catch (error) {
        if (closed && controller.signal.aborted) return 0;
        const attempt = Math.max(...events.map((event) => event.attemptCount)) + 1;
        const retryDelay = Math.min(MAX_RETRY_MS, 5_000 * 2 ** Math.min(attempt - 1, 8));
        outbox.markFailed(
          events.map((event) => event.id),
          deliveryErrorClass(error),
          Date.now() + retryDelay,
        );
        return 0;
      } finally {
        clearTimeout(timeout);
        activeAbortController = null;
      }
    })();

    activeFlush = operation.finally(() => {
      activeFlush = null;
    });
    return activeFlush;
  };

  const failRuntime = () => {
    if (closed) return;
    closed = true;
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
            ({ priority: _priority, ...event }) => ({
              ...event,
              distinct_id: installationId,
            }),
          );
          const accepted = outbox.enqueueBatch(
            events,
            command.events.map((event) => event.priority),
          );
          post({ type: "persisted", batchId: command.batchId, accepted });
          return;
        }
        case "flush": {
          void flush()
            .then((value) => post({ type: "result", requestId: command.requestId, value }))
            .catch(failRuntime);
          return;
        }
        case "set-consent": {
          const value = outbox.purgeAbove(command.consent);
          post({ type: "result", requestId: command.requestId, value });
          return;
        }
        case "pending-count": {
          post({ type: "result", requestId: command.requestId, value: outbox.size() });
          return;
        }
        case "close": {
          closed = true;
          activeAbortController?.abort();
          void (activeFlush ?? Promise.resolve(0)).finally(() => {
            outbox.close();
            post({ type: "result", requestId: command.requestId, value: 0 });
            input.port.close();
          });
          return;
        }
      }
    } catch {
      failRuntime();
    }
  });

  input.port.start();
  post({ type: "ready" });
}
