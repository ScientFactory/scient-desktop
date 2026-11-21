import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { editFromHereSkipsDialog, laterTurnsChangedNoFiles } from "./editFromHereRewind";

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
    readonly changesKnown?: boolean;
  } = {},
) => {
  const scopeId = options.scopeId ?? ROOT_SCOPE;
  const status = options.status ?? "ready";
  return {
    id: `checkpoint-${scopeId}-${ordinal}`,
    scopeId,
    runId: `run-${ordinal}`,
    ordinalWithinScope: ordinal,
    appRunOrdinal: scopeId === ROOT_SCOPE ? ordinal : null,
    status,
    files: (options.files ?? []).map((path) => ({
      path,
      kind: "modified",
      additions: 1,
      deletions: 1,
    })),
    ...(options.filesTotal === undefined
      ? {}
      : { filesTotal: { count: options.filesTotal, additions: 1, deletions: 1 } }),
    // The server records this only for a ready snapshot whose comparison ran.
    ...((options.changesKnown ?? status === "ready") ? { changesKnown: true } : {}),
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

  // regression: a snapshot whose diff failed also lists no file.
  it("is false when the server could not tell what a later turn changed", () => {
    const thread = projection(
      [run(1), run(2)],
      [checkpoint(1), checkpoint(2, { changesKnown: false })],
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

describe("editFromHereSkipsDialog", () => {
  const singleFolder = (runs: ReadonlyArray<Run>, checkpoints: ReadonlyArray<Checkpoint>) =>
    ({
      ...projection(runs, checkpoints),
      checkpointScopes: [{ id: ROOT_SCOPE }],
    }) as unknown as Projection;
  const unchanged = singleFolder(
    [run(1), run(2)],
    [checkpoint(1, { files: ["a.md"] }), checkpoint(2)],
  );
  const skips = (
    thread: Projection,
    options: { readonly worktreePath?: string; readonly projectTracksFolders?: boolean } = {},
  ) =>
    editFromHereSkipsDialog({
      projection: thread,
      worktreePath: options.worktreePath ?? null,
      projectTracksFolders: options.projectTracksFolders ?? false,
      turnCount: 1,
    });

  it("skips the dialog in a single-folder project thread when no later turn changed files", () => {
    expect(skips(unchanged)).toBe(true);
  });

  it("asks in a project folder when a later turn changed files", () => {
    expect(
      skips(singleFolder([run(1), run(2)], [checkpoint(1), checkpoint(2, { files: ["b.md"] })])),
    ).toBe(false);
  });

  // regression: a repository missed by a turn's baselines can change and end clean without being
  // compared, so the thread's folder evidence says nothing about it.
  it("asks in a project with tracked folders, even when the server vouched for its folder", () => {
    expect(skips(unchanged, { projectTracksFolders: true })).toBe(false);
  });

  it("asks when the thread has a repository scope, even with no repository change recorded", () => {
    const thread = projection([run(1), run(2)], [checkpoint(1), checkpoint(2)]);
    expect(laterTurnsChangedNoFiles(thread, 1)).toBe(true);
    expect(skips(thread)).toBe(false);
  });

  it("asks in a worktree, where the dialog can revert files, even with no later change", () => {
    expect(skips(unchanged, { worktreePath: "/worktree" })).toBe(false);
  });

  it("asks in a worktree whose rewind target has no snapshot to restore", () => {
    const thread = singleFolder(
      [run(1), run(2)],
      [checkpoint(1, { status: "error" }), checkpoint(2)],
    );
    expect(skips(thread, { worktreePath: "/worktree" })).toBe(false);
  });

  it("asks when the thread is not loaded", () => {
    expect(
      editFromHereSkipsDialog({
        projection: null,
        worktreePath: null,
        projectTracksFolders: false,
        turnCount: 1,
      }),
    ).toBe(false);
  });
});
