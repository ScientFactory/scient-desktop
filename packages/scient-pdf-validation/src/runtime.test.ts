// @effect-diagnostics nodeBuiltinImport:off -- Real Node workers and finite lifecycle deadlines.
import type * as NodeWorkerThreads from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PDF_VALIDATION_MAX_BYTES } from "./contract.ts";
import { createPdfValidationRuntime } from "./runtime.ts";

interface WorkerRecord {
  readonly worker: NodeWorkerThreads.Worker;
  readonly exit: Promise<number>;
  readonly previousLiveThreadIds: ReadonlyArray<number>;
  exited: boolean;
}

const observed = vi.hoisted(() => {
  const records: WorkerRecord[] = [];
  const created: Array<(record: WorkerRecord) => void> = [];
  return { records, created };
});

// Only observe construction and the native exit event. All workers, messages,
// termination and exit codes remain the real Node implementation.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        const previousLiveThreadIds = observed.records
          .filter((record) => !record.exited)
          .map((record) => record.worker.threadId);
        super(...args);
        const outcome = Promise.withResolvers<number>();
        const record: WorkerRecord = {
          worker: this,
          exit: outcome.promise,
          previousLiveThreadIds,
          exited: false,
        };
        this.once("exit", (code) => {
          record.exited = true;
          outcome.resolve(code);
        });
        observed.records.push(record);
        for (const notify of observed.created.splice(0)) notify(record);
      }
    },
  };
});

function workerUrl(source: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

// These replies exercise the private worker protocol, not PDF parsing. The
// finite open handle makes reply delivery distinct from physical thread exit.
const replyWorker = workerUrl(`
  import { parentPort, workerData } from "node:worker_threads";
  if (workerData.bytes[0] === 0) throw new Error("Controlled worker bootstrap failure");
  const original = workerData.bytes[0];
  workerData.bytes[0] = 77;
  parentPort.postMessage({ _tag: "Success", result: {
    accepted: true, classification: "valid", pageCount: original,
    profile: workerData.profile, warnings: ["blank-pages-allowed"]
  } });
  const handle = setInterval(() => {}, 1000);
  setTimeout(() => { clearInterval(handle); parentPort.close(); }, 2000);
`);

const noReplyWorker = workerUrl(`
  import { parentPort } from "node:worker_threads";
  parentPort.close();
`);

const waitingWorker = workerUrl(`
  import { parentPort } from "node:worker_threads";
  setTimeout(() => parentPort.close(), 2000);
`);

function nextWorker(): Promise<WorkerRecord> {
  return new Promise((resolve) => observed.created.push(resolve));
}

beforeEach(() => {
  observed.records.length = 0;
  observed.created.length = 0;
});

afterEach(async () => {
  await Promise.all(observed.records.map((record) => record.worker.terminate()));
  await Promise.all(observed.records.map((record) => record.exit));
});

describe("PDF validation runtime physical worker lifecycle", () => {
  it("close before queued work starts refuses it without constructing a worker", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: replyWorker });
    try {
      const pending = runtime.validate(new Uint8Array([1]), "browser-export");
      await runtime.close();
      expect(await pending).toMatchObject({
        accepted: false,
        reason: "worker-failed",
        detail: "The PDF validator is closed.",
      });
      expect(observed.records).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("does not construct a queued physical worker while its predecessor is alive", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: replyWorker });
    try {
      const results = await Promise.all([
        runtime.validate(new Uint8Array([1]), "producer-registration"),
        runtime.validate(new Uint8Array([2]), "browser-export"),
        runtime.validate(new Uint8Array([3]), "existing-load"),
      ]);
      expect(results.map((result) => result.pageCount)).toEqual([1, 2, 3]);
      expect(observed.records).toHaveLength(3);
      expect(observed.records.map((record) => record.previousLiveThreadIds)).toEqual([[], [], []]);
      await runtime.close();
      expect(observed.records.every((record) => record.exited)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("close joins a finishing predecessor after its reply was delivered", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: replyWorker });
    try {
      expect((await runtime.validate(new Uint8Array([1]), "browser-export")).accepted).toBe(true);
      await runtime.close();
      expect(observed.records).toHaveLength(1);
      expect(observed.records[0]?.exited).toBe(true);
      expect(observed.records[0]?.worker.threadId).toBe(-1);
      expect(await runtime.validate(new Uint8Array([2]), "browser-export")).toMatchObject({
        accepted: false,
        reason: "worker-failed",
        detail: "The PDF validator is closed.",
      });
      expect(observed.records).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("settles an observed clean exit without a reply as worker failure, not timeout", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: noReplyWorker, timeoutMs: 500 });
    try {
      const receipt = await runtime.validate(new Uint8Array([1]), "browser-export");
      expect(await observed.records[0]?.exit).toBe(0);
      expect(receipt).toMatchObject({
        accepted: false,
        reason: "worker-failed",
        detail: "The PDF validation worker stopped.",
      });
    } finally {
      await runtime.close();
    }
  });

  it("active close joins the owned worker and refuses queued work without spawning it", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: waitingWorker, timeoutMs: 500 });
    try {
      const created = nextWorker();
      const active = runtime.validate(new Uint8Array([1]), "browser-export");
      const queued = runtime.validate(new Uint8Array([2]), "existing-load");
      const worker = await created;
      await runtime.close();
      expect(await active).toMatchObject({ accepted: false, reason: "worker-failed" });
      expect(await queued).toMatchObject({
        accepted: false,
        reason: "worker-failed",
        detail: "The PDF validator is closed.",
        profile: "existing-load",
      });
      expect(worker.exited).toBe(true);
      expect(observed.records).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("joins a bootstrap failure and still processes the next queued job", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: replyWorker });
    try {
      const [failed, successful] = await Promise.all([
        runtime.validate(new Uint8Array([0]), "producer-registration"),
        runtime.validate(new Uint8Array([2]), "browser-export"),
      ]);
      expect(failed).toMatchObject({
        accepted: false,
        reason: "worker-failed",
        detail: "The PDF validation worker failed.",
      });
      expect(successful).toMatchObject({ accepted: true, pageCount: 2 });
      expect(observed.records).toHaveLength(2);
      expect(observed.records.map((record) => record.previousLiveThreadIds)).toEqual([[], []]);
      await runtime.close();
      expect(observed.records.every((record) => record.exited)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("settles real constructor refusal and closes without a worker", async () => {
    const runtime = createPdfValidationRuntime({
      workerUrl: new URL("https://invalid.test/worker"),
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await runtime.validate(new Uint8Array([1]), "browser-export")).toMatchObject({
          accepted: false,
          reason: "worker-failed",
          detail: "The PDF validation worker failed.",
        });
      }
      await runtime.close();
      expect(observed.records).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("returns the configured timeout and close joins its finite no-reply worker", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: waitingWorker, timeoutMs: 100 });
    try {
      expect(await runtime.validate(new Uint8Array([1]), "browser-export")).toMatchObject({
        accepted: false,
        reason: "timed-out",
        detail: "PDF validation exceeded 100 ms.",
      });
      expect(observed.records).toHaveLength(1);
      await runtime.close();
      expect(observed.records[0]?.exited).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("transfers an owned copy and preserves the actual input profile", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: replyWorker });
    try {
      const bytes = new Uint8Array([1]);
      const created = nextWorker();
      const result = runtime.validate(bytes, "existing-load");
      await created;
      bytes[0] = 3;
      expect(await result).toMatchObject({
        accepted: true,
        pageCount: 1,
        profile: "existing-load",
      });
      expect(bytes.byteLength).toBe(1);
      expect(bytes[0]).toBe(3);
    } finally {
      await runtime.close();
    }
  });

  it("refuses empty and oversized buffers without constructing a worker", async () => {
    const runtime = createPdfValidationRuntime({ workerUrl: replyWorker });
    try {
      expect(await runtime.validate(new Uint8Array(), "browser-export")).toMatchObject({
        accepted: false,
        reason: "empty",
      });
      expect(
        await runtime.validate(new Uint8Array(PDF_VALIDATION_MAX_BYTES + 1), "browser-export"),
      ).toMatchObject({ accepted: false, reason: "too-large" });
      expect(observed.records).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});
