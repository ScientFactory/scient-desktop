// @effect-diagnostics nodeBuiltinImport:off -- Starts the real analytics worker entry in a worker thread.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

import type { AnalyticsWorkerInput } from "@scientfactory/analytics";
import { afterEach, describe, expect, it } from "vite-plus/test";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("analytics worker entry", () => {
  it("prepares the worker thread's outbound networking like the main thread", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-analytics-entry-"));
    roots.push(root);
    const entry = new URL("./analytics-worker.ts", import.meta.url).href;
    // Node keeps the Happy Eyeballs attempt timeout per thread; read it inside the worker.
    const probe = `
import * as NodeNet from "node:net";
import { parentPort } from "node:worker_threads";
await import(${JSON.stringify(entry)});
parentPort.postMessage({ type: "probe", attemptTimeout: NodeNet.getDefaultAutoSelectFamilyAttemptTimeout() });
`;
    const worker = new NodeWorkerThreads.Worker(
      new URL(`data:text/javascript,${encodeURIComponent(probe)}`),
      {
        workerData: {
          outboxPath: NodePath.join(root, "outbox.sqlite"),
          endpoint: "http://127.0.0.1:1/v1/events",
          consent: "off",
          purpose: "deletion",
        } satisfies AnalyticsWorkerInput,
      },
    );
    try {
      const attemptTimeout = await new Promise<number>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message: { type: string; attemptTimeout?: number }) => {
          if (message.type === "probe" && message.attemptTimeout !== undefined) {
            resolve(message.attemptTimeout);
          }
        });
      });
      expect(attemptTimeout).toBeGreaterThanOrEqual(1_000);
    } finally {
      await worker.terminate();
    }
  });
});
