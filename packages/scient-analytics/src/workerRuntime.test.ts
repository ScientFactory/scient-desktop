// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Worker delivery tests on a fake clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AnalyticsBatch } from "./contract.ts";
import { normalizeInheritedEvent } from "./contract.ts";
import type {
  AnalyticsEventDraft,
  AnalyticsWorkerCommand,
  AnalyticsWorkerResponse,
} from "./workerProtocol.ts";
import { startAnalyticsWorker } from "./workerRuntime.ts";

type FetchStep = (init: RequestInit) => Promise<Response>;

const EPOCH = "2026-11-15T00:00:00.000Z";
const fixtures: string[] = [];
const ports: NodeWorkerThreads.MessagePort[] = [];

const accepted = (init: RequestInit) =>
  new Response(
    JSON.stringify({
      accepted: (JSON.parse(String(init.body)) as AnalyticsBatch).events.length,
    }),
    { status: 202 },
  );
const ok: FetchStep = async (init) => accepted(init);
const networkError: FetchStep = async () => {
  throw new TypeError("fetch failed");
};
const untilAborted: FetchStep = (init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

function draft(name = "project.opened"): AnalyticsEventDraft {
  const normalized = normalizeInheritedEvent(
    name,
    {},
    { appVersion: "0.6.30", buildChannel: "stable" },
  );
  if (!normalized) throw new Error("Test requires a registered event");
  return {
    id: NodeCrypto.randomUUID(),
    name,
    session_id: `session:${NodeCrypto.randomUUID()}`,
    occurred_at: EPOCH,
    privacy_level: normalized.privacyLevel,
    consent_level: "diagnostic",
    properties: normalized.properties,
    priority: normalized.priority,
  };
}

async function startWorker(steps: ReadonlyArray<FetchStep>, fallback: FetchStep = ok) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-analytics-worker-"));
  fixtures.push(root);
  const bodies: AnalyticsBatch[] = [];
  const fetchMock = vi.fn((_url: URL | string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as AnalyticsBatch);
    return (steps[fetchMock.mock.calls.length - 1] ?? fallback)(init);
  });
  vi.stubGlobal("fetch", fetchMock);

  const channel = new NodeWorkerThreads.MessageChannel();
  ports.push(channel.port1, channel.port2);
  const responses: AnalyticsWorkerResponse[] = [];
  const waiters = new Set<() => void>();
  channel.port2.on("message", (response: AnalyticsWorkerResponse) => {
    responses.push(response);
    for (const waiter of waiters) waiter();
  });
  startAnalyticsWorker({
    port: channel.port1,
    outboxPath: NodePath.join(root, "outbox.sqlite"),
    endpoint: "http://127.0.0.1:1/v1/events",
  });

  const waitFor = <T extends AnalyticsWorkerResponse>(
    match: (response: AnalyticsWorkerResponse) => response is T,
  ): Promise<T> =>
    new Promise((resolve) => {
      const check = () => {
        const found = responses.find(match);
        if (!found) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });
  const send = (command: AnalyticsWorkerCommand) => channel.port2.postMessage(command);
  let nextId = 1;
  const enqueue = async (events: ReadonlyArray<AnalyticsEventDraft>) => {
    const batchId = nextId++;
    send({ type: "enqueue", batchId, events });
    await waitFor(
      (response): response is Extract<AnalyticsWorkerResponse, { type: "persisted" }> =>
        response.type === "persisted" && response.batchId === batchId,
    );
  };
  const result = (requestId: number) =>
    waitFor(
      (response): response is Extract<AnalyticsWorkerResponse, { type: "result" }> =>
        response.type === "result" && response.requestId === requestId,
    ).then((response) => response.value);
  const command = (make: (requestId: number) => AnalyticsWorkerCommand) => {
    const requestId = nextId++;
    send(make(requestId));
    return result(requestId);
  };
  const flush = () => command((requestId) => ({ type: "flush", requestId }));
  const pendingCount = () => command((requestId) => ({ type: "pending-count", requestId }));

  await waitFor((response): response is { type: "ready" } => response.type === "ready");
  return { fetchMock, bodies, enqueue, flush, pendingCount, command, send };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(Date.parse(EPOCH));
  // Jitter at its midpoint makes each backoff exactly its base value.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const port of ports.splice(0)) port.close();
  for (const root of fixtures.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("analytics worker delivery", () => {
  it("delivers an acknowledgement that arrives after five seconds", async () => {
    const sent = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    const worker = await startWorker([
      async (init) => {
        sent.resolve();
        await Promise.race([
          reply.promise,
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
        ]);
        return accepted(init);
      },
    ]);
    await worker.enqueue([draft()]);
    const flushed = worker.flush();
    await sent.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    reply.resolve();
    expect(await flushed).toBe(1);
    expect(await worker.pendingCount()).toBe(0);
  });

  it("backs off the endpoint instead of parking the events a failed send carried", async () => {
    const worker = await startWorker([networkError, networkError, networkError, networkError]);
    const first = draft();
    await worker.enqueue([first]);
    // Scheduled flushes fail at 30 s, then back off 30 s, 60 s and 120 s.
    for (const wait of [30_000, 30_000, 60_000, 120_000]) {
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(worker.fetchMock).toHaveBeenCalledTimes(4);
    const second = draft();
    await worker.enqueue([second]);
    await vi.advanceTimersByTimeAsync(239_000);
    expect(worker.fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.fetchMock).toHaveBeenCalledTimes(5);
    expect(worker.bodies[4]?.events.map((event) => event.id).toSorted()).toEqual(
      [first.id, second.id].toSorted(),
    );
    expect(await worker.pendingCount()).toBe(0);
  });

  it("keeps an unexpired event through 25 transport failures and delivers it", async () => {
    const steps = Array.from({ length: 25 }, (_, index) =>
      index % 2 === 0 ? untilAborted : networkError,
    );
    const worker = await startWorker(steps);
    const only = draft();
    await worker.enqueue([only]);
    for (let attempt = 0; attempt < 26; attempt += 1) {
      await vi.advanceTimersByTimeAsync(16 * 60_000);
    }
    expect(worker.fetchMock).toHaveBeenCalledTimes(26);
    expect(worker.bodies[25]?.events.map((event) => event.id)).toEqual([only.id]);
    expect(await worker.pendingCount()).toBe(0);
  });

  it("honours Retry-After on 429 beyond the endpoint's own backoff", async () => {
    const worker = await startWorker([
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "120" } }),
    ]);
    await worker.enqueue([draft()]);
    expect(await worker.flush()).toBe(0);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(worker.fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.fetchMock).toHaveBeenCalledTimes(2);
    expect(await worker.pendingCount()).toBe(0);
  });

  it("drains a backlog in one flush and stops between batches when closed", async () => {
    const drained = await startWorker([]);
    await drained.enqueue(Array.from({ length: 400 }, () => draft()));
    expect(await drained.flush()).toBe(400);
    expect(drained.fetchMock).toHaveBeenCalledTimes(8);

    const secondSend = Promise.withResolvers<void>();
    const interrupted = await startWorker([
      ok,
      (init) => {
        secondSend.resolve();
        return untilAborted(init);
      },
    ]);
    await interrupted.enqueue(Array.from({ length: 400 }, () => draft()));
    const flushed = interrupted.flush();
    await secondSend.promise;
    await interrupted.command((requestId) => ({ type: "close", requestId }));
    expect(await flushed).toBe(50);
    expect(interrupted.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts another slow upload only while its deadline fits the flush budget", async () => {
    const uploads = [0, 1].map(() => ({
      started: Promise.withResolvers<void>(),
      reply: Promise.withResolvers<void>(),
    }));
    let next = 0;
    const slow: FetchStep = async (init) => {
      const upload = uploads[next++];
      upload?.started.resolve();
      await upload?.reply.promise;
      return accepted(init);
    };
    const worker = await startWorker([], slow);
    await worker.enqueue(Array.from({ length: 150 }, () => draft()));
    const flushed = worker.flush();
    for (const upload of uploads) {
      await upload.started.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      upload.reply.resolve();
    }
    // A third upload starting at 20 s could run past the 30 s budget, so the flush ends here.
    expect(await flushed).toBe(100);
    expect(worker.fetchMock).toHaveBeenCalledTimes(2);
  });
});
