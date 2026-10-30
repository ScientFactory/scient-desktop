import { describe, expect, it } from "@effect/vitest";
import type { ComputeExecutionRecord, ComputeSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  consoleNotebookDocument,
  consoleRunsWorthKeeping,
  makeComputeConsoleNotebook,
} from "./ComputeConsoleNotebook.ts";

const run = (
  id: string,
  source: "console" | "document",
  status: string,
  submittedAt: string,
): ComputeExecutionRecord =>
  ({
    request: {
      executionId: id,
      code: id,
      submittedAt,
      source: source === "console" ? { _tag: "console" } : { _tag: "document" },
    },
    result: { status },
  }) as unknown as ComputeExecutionRecord;

describe("console notebook", () => {
  it("keeps what worked at the Console, in the order it ran", () => {
    const kept = consoleRunsWorthKeeping([
      run("second", "console", "succeeded", "2026-10-30T10:02:00Z"),
      run("failed", "console", "failed", "2026-10-30T10:01:30Z"),
      run("file", "document", "succeeded", "2026-10-30T10:01:40Z"),
      run("first", "console", "succeeded", "2026-10-30T10:01:00Z"),
    ]);
    expect(kept.map((execution) => execution.request.code)).toEqual(["first", "second"]);
  });

  it.effect("saves every run, not only the newest the feed shows", () =>
    Effect.gen(function* () {
      const history = Array.from({ length: 450 }, (_, index) =>
        run(`run-${index}`, "console", "succeeded", String(index).padStart(4, "0")),
      );
      let written = "";
      const save = makeComputeConsoleNotebook({
        gateway: {
          getSession: () => Effect.succeed({ languageId: "python", label: "Python" }),
          listAllExecutions: () => Effect.succeed(history),
        },
        notebookOutputs: () => Effect.succeed({ outputs: [], executionCount: null }),
        workspaceFileSystem: {
          createBinaryFile: ({
            bytes,
            relativePath,
          }: {
            bytes: Uint8Array;
            relativePath: string;
          }) =>
            Effect.sync(() => {
              written = new TextDecoder().decode(bytes);
              return { relativePath };
            }),
        },
      } as unknown as Parameters<typeof makeComputeConsoleNotebook>[0]);
      yield* save({ cwd: "/project", sessionId: "session" as ComputeSessionId });
      const cells: ReadonlyArray<{ source: string }> = JSON.parse(written).cells;
      expect(cells).toHaveLength(450);
      expect(cells[0]?.source).toBe("run-0");
    }),
  );

  it("writes a notebook Scient reopens in the same language", () => {
    const document = JSON.parse(
      consoleNotebookDocument({
        languageId: "python",
        displayName: "Python",
        cells: [
          { code: "x = 1", outputs: { outputs: [], executionCount: null } },
          {
            code: "x",
            outputs: {
              outputs: [{ output_type: "execute_result", execution_count: 2 }],
              executionCount: 2,
            },
          },
        ],
      }),
    );
    expect(document.nbformat).toBe(4);
    expect(document.metadata.language_info.name).toBe("python");
    expect(document.cells.map((cell: { source: string }) => cell.source)).toEqual(["x = 1", "x"]);
    expect(document.cells.map((cell: { id: string }) => cell.id)).toEqual([
      "console-1",
      "console-2",
    ]);
    expect(document.cells[0].execution_count).toBe(1);
    expect(document.cells[1].execution_count).toBe(2);
  });
});
