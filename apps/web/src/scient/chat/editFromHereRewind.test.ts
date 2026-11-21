import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { laterTurnsChangedNoFiles } from "./editFromHereRewind";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "checkpoints" | "checkpointScopes"
>;
type Run = Projection["runs"][number];
type Checkpoint = Projection["checkpoints"][number];

const ROOT_SCOPE = "scope-root";
const REPOSITORY_SCOPE = "scope-repository";

const run = (ordinal: number, status: Run["status"] = "completed") =>
  ({ id: `run-${ordinal}`, ordinal, status }) as unknown as Run;

const checkpoint = (
  ordinal: number,
  options: {
    readonly scopeId?: string;
    readonly status?: Checkpoint["status"];
    readonly files?: ReadonlyArray<string>;
    readonly filesTotal?: number;
  } = {},
) => {
  const scopeId = options.scopeId ?? ROOT_SCOPE;
  return {
    id: `checkpoint-${scopeId}-${ordinal}`,
    scopeId,
    runId: `run-${ordinal}`,
    ordinalWithinScope: ordinal,
    appRunOrdinal: scopeId === ROOT_SCOPE ? ordinal : null,
    status: options.status ?? "ready",
    files: (options.files ?? []).map((path) => ({
      path,
      kind: "modified",
      additions: 1,
      deletions: 1,
    })),
    ...(options.filesTotal === undefined
      ? {}
      : { filesTotal: { count: options.filesTotal, additions: 1, deletions: 1 } }),
  } as unknown as Checkpoint;
};

const projection = (runs: ReadonlyArray<Run>, checkpoints: ReadonlyArray<Checkpoint>): Projection =>
  ({
    runs,
    checkpoints,
    checkpointScopes: [
      { id: ROOT_SCOPE },
      { id: REPOSITORY_SCOPE, repositoryPath: "/project/lab-tools" },
    ],
  }) as unknown as Projection;

describe("laterTurnsChangedNoFiles", () => {
  it("is true when nothing comes after the message", () => {
    expect(
      laterTurnsChangedNoFiles(projection([run(1)], [checkpoint(1, { files: ["a.md"] })]), 1),
    ).toBe(true);
  });

  it("is true when every later turn's snapshot lists no file", () => {
    const thread = projection(
      [run(1), run(2), run(3, "interrupted")],
      [checkpoint(1, { files: ["notes.md"] }), checkpoint(2), checkpoint(3)],
    );
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(true);
  });

  it("is false when a later turn changed a file in the thread's folder", () => {
    const thread = projection(
      [run(1), run(2), run(3)],
      [checkpoint(1), checkpoint(2), checkpoint(3, { files: ["analysis.py"] })],
    );
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(false);
  });

  it("is false when a later turn's file list is a prefix that left the files out", () => {
    const thread = projection([run(1), run(2)], [checkpoint(1), checkpoint(2, { filesTotal: 3 })]);
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(false);
  });

  it("is false when a later turn changed only a tracked repository", () => {
    const thread = projection(
      [run(1), run(2)],
      [
        checkpoint(1),
        checkpoint(2),
        checkpoint(2, { scopeId: REPOSITORY_SCOPE, files: ["lib.rs"] }),
      ],
    );
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(false);
  });

  it("is false when a repository capture failed for a later turn", () => {
    const thread = projection(
      [run(1), run(2)],
      [checkpoint(1), checkpoint(2), checkpoint(2, { scopeId: REPOSITORY_SCOPE, status: "error" })],
    );
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(false);
  });

  it.each(["missing", "error"] as const)(
    "is false when a later turn's snapshot is %s",
    (status) => {
      const thread = projection([run(1), run(2)], [checkpoint(1), checkpoint(2, { status })]);
      expect(laterTurnsChangedNoFiles(thread, 1)).toBe(false);
    },
  );

  it("is false when a later turn has no snapshot loaded", () => {
    expect(laterTurnsChangedNoFiles(projection([run(1), run(2)], [checkpoint(1)]), 1)).toBe(false);
  });

  it("is false when a later turn is still running", () => {
    const thread = projection([run(1), run(2, "running")], [checkpoint(1)]);
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(false);
  });

  it("is false when the thread is not loaded", () => {
    expect(laterTurnsChangedNoFiles(null, 1)).toBe(false);
  });

  it("ignores turns an earlier rewind already undid", () => {
    const thread = projection(
      [run(1), run(2, "rolled_back"), run(3)],
      [
        checkpoint(1),
        checkpoint(2, { status: "stale", files: ["discarded.md"] }),
        checkpoint(2, { scopeId: REPOSITORY_SCOPE, status: "stale", files: ["lib.rs"] }),
        checkpoint(3),
      ],
    );
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(true);
  });
});
