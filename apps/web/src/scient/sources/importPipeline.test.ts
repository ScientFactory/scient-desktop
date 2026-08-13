import type { EnvironmentId, ScientSourceImportOperation } from "@t3tools/contracts";
import { describe, expect, test } from "vite-plus/test";

import { continueSourceImport, stopSourceImportContinuation } from "./importPipeline";

const environmentId = "local" as EnvironmentId;

function operation(
  operationId: string,
  states: ReadonlyArray<"pending" | "imported">,
): ScientSourceImportOperation {
  const completed = states.every((state) => state !== "pending");
  return {
    formatVersion: 1,
    operationId,
    projectId: "project",
    adapter: "local-files",
    state: completed ? "completed" : "running",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    items: states.map((state, index) => ({
      itemKey: `item-${index}`,
      state,
      sourceId: state === "imported" ? `source-${index}` : null,
      message: null,
    })),
  };
}

describe("source import continuation", () => {
  test("drains a durable operation to completion", async () => {
    let next = operation("drain", ["pending", "pending"]);
    const progress: ScientSourceImportOperation[] = [];
    const result = await continueSourceImport({
      environmentId,
      root: "/project",
      operation: next,
      advance: async () => {
        const pending = next.items.findIndex((item) => item.state === "pending");
        next = operation(
          "drain",
          next.items.map((item, index) =>
            index === pending || item.state === "imported" ? "imported" : "pending",
          ),
        );
        return next;
      },
      onProgress: (value) => progress.push(value),
    });

    expect(result.state).toBe("completed");
    expect(progress).toHaveLength(2);
  });

  test("shares one driver when the same operation is observed twice", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initial = operation("shared", ["pending"]);
    const advance = async () => {
      calls += 1;
      await gate;
      return operation("shared", ["imported"]);
    };

    const first = continueSourceImport({
      environmentId,
      root: "/project",
      operation: initial,
      advance,
    });
    const second = continueSourceImport({
      environmentId,
      root: "/project",
      operation: initial,
      advance,
    });
    release?.();

    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test("does not let a presentation listener interrupt durable progress", async () => {
    let calls = 0;
    const result = await continueSourceImport({
      environmentId,
      root: "/project",
      operation: operation("listener", ["pending", "pending"]),
      advance: async () => {
        calls += 1;
        return operation(
          "listener",
          calls === 1 ? ["imported", "pending"] : ["imported", "imported"],
        );
      },
      onProgress: () => {
        throw new Error("detached view");
      },
    });

    expect(result.state).toBe("completed");
    expect(calls).toBe(2);
  });

  test("stops before beginning another item after cancellation is requested", async () => {
    let calls = 0;
    const initial = operation("cancel", ["pending", "pending"]);
    const result = await continueSourceImport({
      environmentId,
      root: "/project",
      operation: initial,
      advance: async () => {
        calls += 1;
        stopSourceImportContinuation({
          environmentId,
          projectId: "project",
          operationId: "cancel",
        });
        return operation("cancel", ["imported", "pending"]);
      },
    });

    expect(calls).toBe(1);
    expect(result.items[1]?.state).toBe("pending");
  });
});
