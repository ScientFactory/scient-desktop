// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- This package owns Scient's local worker boundary.
import * as NodeCrypto from "node:crypto";
import { Worker } from "node:worker_threads";

import {
  type AnalyticsConsent,
  type AnalyticsPriority,
  consentAllows,
  type NormalizationContext,
  normalizeInheritedEvent,
} from "./contract.ts";
import type {
  AnalyticsEventDraft,
  AnalyticsWorkerCommand,
  AnalyticsWorkerResponse,
} from "./workerProtocol.ts";

const DEFAULT_ENDPOINT = "https://events.scientfactory.com/v1/events";
const MEMORY_QUEUE_LIMIT = 1_000;
const WORKER_BATCH_SIZE = 100;
const MAX_IN_FLIGHT_BATCHES = 2;
const WRITE_COALESCE_MS = 100;
const CONTROL_TIMEOUT_MS = 3_500;
const LOCAL_SHUTDOWN_BUDGET_MS = 300;

const PRIORITY_RANK: Readonly<Record<AnalyticsPriority, number>> = {
  critical: 0,
  core: 1,
  summary: 2,
};

export interface AnalyticsRuntimeOptions extends NormalizationContext {
  readonly enabled: boolean;
  readonly consent: AnalyticsConsent;
  readonly outboxPath: string;
  readonly endpoint?: string;
  readonly workerUrl?: URL;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export interface AnalyticsRuntime {
  readonly enabled: boolean;
  readonly record: (name: string, properties?: Readonly<Record<string, unknown>>) => boolean;
  readonly flush: () => Promise<number>;
  readonly setConsent: (consent: AnalyticsConsent) => Promise<number>;
  readonly pendingCount: () => Promise<number>;
  readonly close: () => Promise<void>;
}

function disabledRuntime(): AnalyticsRuntime {
  return {
    enabled: false,
    record: () => false,
    flush: async () => 0,
    setConsent: async () => 0,
    pendingCount: async () => 0,
    close: async () => undefined,
  };
}

function waitForCondition(satisfied: () => boolean, deadline: number): Promise<void> {
  return new Promise((resolve) => {
    const poll = () => {
      if (satisfied() || Date.now() >= deadline) {
        resolve();
        return;
      }
      const timer = setTimeout(poll, 5);
      timer.unref();
    };
    poll();
  });
}

export function createAnalyticsRuntime(options: AnalyticsRuntimeOptions): AnalyticsRuntime {
  if (!options.enabled || options.consent === "off") return disabledRuntime();

  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? NodeCrypto.randomUUID;
  const sessionId = `session:${randomUUID()}`;
  const worker = new Worker(options.workerUrl ?? new URL("./worker-entry.ts", import.meta.url), {
    workerData: {
      outboxPath: options.outboxPath,
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    },
  });
  worker.unref();

  let consent: AnalyticsConsent = options.consent;
  let ready = false;
  let available = true;
  let closed = false;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let nextBatchId = 1;
  let nextRequestId = 1;
  const queue: AnalyticsEventDraft[] = [];
  const inFlight = new Map<number, ReadonlyArray<AnalyticsEventDraft>>();
  const requests = new Map<
    number,
    {
      readonly resolve: (value: number) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  const bufferedCount = () =>
    queue.length + [...inFlight.values()].reduce((count, batch) => count + batch.length, 0);

  const settleRequests = () => {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.resolve(0);
    }
    requests.clear();
  };

  const disable = () => {
    if (!available) return;
    available = false;
    ready = false;
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    queue.length = 0;
    inFlight.clear();
    settleRequests();
  };

  const post = (command: AnalyticsWorkerCommand): boolean => {
    if (!available) return false;
    try {
      worker.postMessage(command);
      return true;
    } catch {
      disable();
      return false;
    }
  };

  const drain = () => {
    if (!ready || !available || closed) return;
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    while (queue.length > 0 && inFlight.size < MAX_IN_FLIGHT_BATCHES) {
      const batch = queue.splice(0, WORKER_BATCH_SIZE);
      const batchId = nextBatchId++;
      inFlight.set(batchId, batch);
      if (!post({ type: "enqueue", batchId, events: batch })) {
        inFlight.delete(batchId);
        return;
      }
    }
  };

  const scheduleDrain = () => {
    if (!ready || writeTimer !== null || closed) return;
    writeTimer = setTimeout(drain, WRITE_COALESCE_MS);
    writeTimer.unref();
  };

  const request = (
    command: (requestId: number) => AnalyticsWorkerCommand,
    timeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<number> => {
    if (!available) return Promise.resolve(0);
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        requests.delete(requestId);
        resolve(0);
      }, timeoutMs);
      timer.unref();
      requests.set(requestId, { resolve, timer });
      if (!post(command(requestId))) {
        clearTimeout(timer);
        requests.delete(requestId);
        resolve(0);
      }
    });
  };

  worker.on("message", (response: AnalyticsWorkerResponse) => {
    switch (response.type) {
      case "ready":
        ready = true;
        drain();
        return;
      case "persisted":
        inFlight.delete(response.batchId);
        drain();
        return;
      case "result": {
        const pending = requests.get(response.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        requests.delete(response.requestId);
        pending.resolve(response.value);
        return;
      }
      case "fatal":
        disable();
        return;
    }
  });
  worker.on("error", disable);
  worker.on("exit", () => {
    if (!closed) disable();
  });

  const admit = (event: AnalyticsEventDraft): boolean => {
    if (queue.length < MEMORY_QUEUE_LIMIT) {
      queue.push(event);
      return true;
    }
    const incomingRank = PRIORITY_RANK[event.priority];
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const queued = queue[index];
      if (queued && PRIORITY_RANK[queued.priority] > incomingRank) {
        queue.splice(index, 1, event);
        return true;
      }
    }
    return false;
  };

  const record: AnalyticsRuntime["record"] = (name, properties) => {
    if (closed || !available || consent === "off") return false;
    const normalized = normalizeInheritedEvent(name, properties, options);
    if (!normalized || !consentAllows(consent, normalized.privacyLevel)) return false;
    const accepted = admit({
      id: randomUUID(),
      name: normalized.name,
      session_id: sessionId,
      occurred_at: now().toISOString(),
      privacy_level: normalized.privacyLevel,
      consent_level: consent,
      properties: normalized.properties,
      priority: normalized.priority,
    });
    if (accepted) scheduleDrain();
    return accepted;
  };

  return {
    enabled: true,
    record,
    flush: async () => {
      if (closed || !available) return 0;
      await waitForCondition(() => ready || !available, Date.now() + CONTROL_TIMEOUT_MS);
      if (!ready || !available) return 0;
      drain();
      return request((requestId) => ({ type: "flush", requestId }));
    },
    setConsent: async (nextConsent) => {
      consent = nextConsent;
      let purged = 0;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const event = queue[index];
        if (event && !consentAllows(nextConsent, event.privacy_level)) {
          queue.splice(index, 1);
          purged += 1;
        }
      }
      if (!available) return purged;
      await waitForCondition(() => ready || !available, Date.now() + CONTROL_TIMEOUT_MS);
      if (!ready || !available) return purged;
      drain();
      return (
        purged +
        (await request((requestId) => ({
          type: "set-consent",
          requestId,
          consent: nextConsent,
        })))
      );
    },
    pendingCount: async () => {
      if (closed || !available) return bufferedCount();
      await waitForCondition(() => ready || !available, Date.now() + CONTROL_TIMEOUT_MS);
      if (!ready || !available) return bufferedCount();
      drain();
      return queue.length + (await request((requestId) => ({ type: "pending-count", requestId })));
    },
    close: async () => {
      if (closed) return;
      if (writeTimer !== null) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      drain();
      const deadline = Date.now() + LOCAL_SHUTDOWN_BUDGET_MS;
      await waitForCondition(() => queue.length === 0 && inFlight.size === 0, deadline);
      closed = true;
      if (available) {
        await request(
          (requestId) => ({ type: "close", requestId }),
          Math.max(1, deadline - Date.now()),
        );
      }
      disable();
      await worker.terminate().catch(() => undefined);
    },
  };
}
