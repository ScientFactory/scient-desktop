import type {
  ScientOverleafReview,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  outgoingAfterDecisions,
  readNothingToDoLine,
  reviewHeldLines,
  overleafSyncSucceeded,
  askAgentMessage,
  choicesFor,
  connectionForPath,
  countOverleafConflictBlocks,
  overleafConflictBlocks,
  resolvedConflictLines,
  folderNameProblem,
  newFolderPath,
  workspaceFolderPath,
  workspaceFolderProblem,
  OVERLEAF_REQUEST_FAILED,
  operationErrorText,
  overleafChipView,
  overleafResultView,
  overleafUndoView,
  overleafUndoSucceeded,
  parseOverleafProjectInput,
  refusalText,
  setAsideAction,
  unreadableRecordLines,
  workspacePathOf,
} from "./overleafModel";

const ID = "0123456789abcdef01234567";

const connection = {
  connectionId: "c1",
  checkoutRoot: "/work/project",
  folder: "paper",
  projectId: ID,
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 1,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
};

function status(overrides: Partial<ScientOverleafStatus> = {}): ScientOverleafStatus {
  return {
    connection,
    availability: "ready",
    reasons: [],
    local: { _tag: "read", changed: 0, deleted: 0, added: 0 },
    markerPaths: [],
    revision: 1,
    unresolvedSends: 0,
    keptCopies: 0,
    busy: false,
    linkedElsewhere: false,
    ...overrides,
  };
}

function review(overrides: Partial<ScientOverleafReview> = {}): ScientOverleafReview {
  return {
    reviewId: "r1",
    digest: "d1",
    remoteTree: "a".repeat(40),
    upToDate: false,
    needsDecision: false,
    incoming: [],
    outgoing: [],
    conflicts: [],
    warnings: [],
    unresolvedMarkers: [],
    heldWithMarked: [],
    released: [],
    collisions: [],
    selectedAdditions: [],
    additions: [],
    localOnly: [],
    ...overrides,
  };
}

function synced(
  overrides: Partial<Extract<ScientOverleafSyncResult, { _tag: "synced" }>> = {},
): ScientOverleafSyncResult {
  return {
    _tag: "synced",
    settled: null,
    review: review(),
    outcome: "complete",
    interrupted: 0,
    markerPaths: [],
    publication: { _tag: "accepted", attemptNumber: 1 },
    retried: false,
    activity: [],
    linkedElsewhere: false,
    ...overrides,
  };
}

describe("parseOverleafProjectInput", () => {
  it("accepts an ID, a project link and a Git link, and nothing else", () => {
    expect(parseOverleafProjectInput(` ${ID} `)).toBe(ID);
    expect(parseOverleafProjectInput(`https://www.overleaf.com/project/${ID}`)).toBe(ID);
    expect(parseOverleafProjectInput(`https://overleaf.com/project/${ID}/`)).toBe(ID);
    expect(parseOverleafProjectInput(`https://git.overleaf.com/${ID}`)).toBe(ID);
    expect(parseOverleafProjectInput(`http://www.overleaf.com/project/${ID}`)).toBeNull();
    expect(parseOverleafProjectInput(`https://evil.example/project/${ID}`)).toBeNull();
    expect(parseOverleafProjectInput(`https://user:pw@www.overleaf.com/project/${ID}`)).toBeNull();
    expect(parseOverleafProjectInput("Main paper")).toBeNull();
  });
});

describe("paths", () => {
  it("finds the link whose folder holds a file, and only that one", () => {
    const links = [
      { ...connection, folder: "paper" },
      { ...connection, folder: "slides/talk" },
    ];
    expect(connectionForPath(links, "paper/main.tex")?.folder).toBe("paper");
    expect(connectionForPath(links, "paper")?.folder).toBe("paper");
    expect(connectionForPath(links, "papers/main.tex")).toBeNull();
    expect(connectionForPath(links, "slides/talk/a.tex")?.folder).toBe("slides/talk");
    expect(connectionForPath([{ ...connection, folder: "" }], "any/file.tex")?.folder).toBe("");
  });

  it("names folders and paths from the workspace", () => {
    expect(workspacePathOf("paper", "main.tex")).toBe("paper/main.tex");
    expect(workspacePathOf("", "main.tex")).toBe("main.tex");
    expect(newFolderPath("", " thesis ")).toBe(" thesis ");
    expect(folderNameProblem(" thesis ")).not.toBeNull();
    expect(newFolderPath("papers/", "thesis")).toBe("papers/thesis");
    expect(folderNameProblem("")).not.toBeNull();
    expect(folderNameProblem("COM³.tex")).not.toBeNull();
    expect(folderNameProblem("é".repeat(128))).not.toBeNull();
    expect(folderNameProblem("a".repeat(255))).toBeNull();
    expect(folderNameProblem("a/b")).not.toBeNull();
    expect(folderNameProblem(".hidden")).not.toBeNull();
    expect(folderNameProblem("paper")).toBeNull();
    // A picked or typed folder inside the workspace.
    expect(workspaceFolderPath(" papers/2024/ ")).toBe("papers/2024");
    expect(workspaceFolderPath("/")).toBe("");
    expect(workspaceFolderProblem("")).toBeNull();
    expect(workspaceFolderProblem("papers/2024")).toBeNull();
    expect(workspaceFolderProblem("../outside")).not.toBeNull();
    expect(workspaceFolderProblem("papers//x")).not.toBeNull();
    expect(workspaceFolderProblem(".hidden")).not.toBeNull();
    expect(workspaceFolderProblem("/abs/path")).not.toBeNull();
  });
});

describe("overleafChipView", () => {
  it("says up to date only once Overleaf was asked, and says when Overleaf changed", () => {
    expect(overleafChipView(status(), false).label).toBe("No edits to send");
    expect(overleafChipView(status(), false, null, "unknown")).toMatchObject({
      label: "No edits to send",
      detail: "Scient couldn't check Overleaf just now.",
    });
    expect(overleafChipView(status(), false, null, "changed")).toMatchObject({
      state: "incoming",
      label: "Changes in Overleaf",
    });
    expect(
      overleafChipView(
        status({ local: { _tag: "read", changed: 1, deleted: 0, added: 0 } }),
        false,
        null,
        "changed",
      ),
    ).toMatchObject({ label: "Edits to send", detail: "1 change to send. Overleaf changed too." });
  });

  it("says a link that never synced hasn't, not that it has nothing to send", () => {
    const fresh = status();
    expect(
      overleafChipView(
        { ...fresh, connection: { ...fresh.connection, completedSyncCount: 0 } },
        false,
      ),
    ).toMatchObject({ state: "incoming", label: "Not synced yet" });
  });

  it("names a link whose folder is gone, with the way out", () => {
    expect(
      overleafChipView(status({ availability: "unavailable", local: null }), false).detail,
    ).toBe(
      "The linked folder was moved, renamed, replaced or deleted. Link it again at its new place, or unlink it.",
    );
  });

  it("shows up to date, edits to send, needs a decision and a problem", () => {
    expect(overleafChipView(status(), false, null, "same")).toMatchObject({
      state: "up-to-date",
      label: "Up to date",
      detail: "Same as Overleaf.",
    });
    expect(
      overleafChipView(
        status({ local: { _tag: "read", changed: 2, deleted: 0, added: 1 } }),
        false,
      ),
    ).toMatchObject({ state: "edits", label: "Edits to send", detail: "3 changes to send." });
    expect(
      overleafChipView(
        status({
          reasons: ["conflict-marks"],
          markerPaths: ["main.tex"],
          availability: "attention",
        }),
        false,
      ),
    ).toMatchObject({ state: "decision", label: "Needs a decision" });
    expect(
      overleafChipView(status({ availability: "unavailable", local: null }), false).state,
    ).toBe("problem");
    expect(
      overleafChipView(status({ reasons: ["folder-changed"], availability: "attention" }), false)
        .state,
    ).toBe("problem");
    expect(
      overleafChipView(status({ local: { _tag: "unread", reason: "walk-limit" } }), false).state,
    ).toBe("problem");
  });

  it("an interrupted sync is something to send, not a problem", () => {
    expect(overleafChipView(status({ availability: "recovery-required" }), false).state).toBe(
      "edits",
    );
  });

  it("a running sync wins over everything", () => {
    expect(overleafChipView(status({ reasons: ["conflict-marks"] }), true).state).toBe("syncing");
    expect(overleafChipView(status({ busy: true }), false).state).toBe("syncing");
  });
});

describe("overleafResultView", () => {
  it("counts what came in and what was sent", () => {
    const view = overleafResultView(
      synced({
        review: review({
          incoming: [
            { kind: "modified", path: "a.tex" },
            { kind: "added", path: "b.tex" },
            { kind: "deleted", path: "c.tex" },
          ],
          outgoing: [
            { kind: "modified", path: "d.tex" },
            { kind: "added", path: "e.tex" },
          ],
        }),
      }),
    );
    expect(view.title).toBe("3 files came in, 2 were sent");
    expect(view.tone).toBe("success");
    expect(view.hasChanges).toBe(true);
    expect(view.lines).toEqual([]);
  });

  it("says nothing was sent when the send didn't reach Overleaf", () => {
    const blocked = overleafResultView(
      synced({
        review: review({ outgoing: [{ kind: "modified", path: "d.tex" }] }),
        publication: { _tag: "blocked", reason: "markers" },
        markerPaths: ["main.tex"],
      }),
    );
    // Nothing moved but a file waits: the headline says so, and the file is named.
    expect(blocked.title).toBe("1 file waits for conflicts");
    expect(blocked.lines).toEqual([
      "Nothing was sent: 1 file still has conflict marks. Settle them and sync again.",
      "Waiting for conflict marks to be settled: main.tex.",
    ]);
    expect(blocked.tone).toBe("warning");
    expect(
      overleafResultView(synced({ publication: { _tag: "unknown", attemptNumber: 3 } })).lines[0],
    ).toContain("never sends it twice");
    expect(
      overleafResultView(synced({ publication: { _tag: "out-of-date", attemptNumber: 3 } }))
        .lines[0],
    ).toBe("Overleaf changed again while this sync was sending. Sync again.");
  });

  it("says Overleaf's changes came in only when the apply wrote them all", () => {
    const incoming = review({
      incoming: [{ kind: "modified", path: "a.tex" }],
      outgoing: [{ kind: "modified", path: "d.tex" }],
      warnings: [{ kind: "rename", from: "x.tex", to: "y.tex" }],
    });
    const attention = { _tag: "blocked" as const, reason: "attention" };
    const replanned = overleafResultView(
      synced({ review: incoming, outcome: "replan", publication: attention }),
    );
    expect(replanned).toMatchObject({ title: "Nothing came in", hasChanges: false });
    expect(replanned.lines).toEqual([
      "The folder changed while Overleaf's changes were being written, so nothing was written or sent. Sync again.",
    ]);
    const partway = overleafResultView(
      synced({ review: incoming, outcome: "attention", interrupted: 2, publication: attention }),
    );
    expect(partway.title).toBe("Overleaf's changes were applied as far as the folder allowed");
    expect(partway.lines).toEqual([
      "Writing stopped partway in 2 files. The next sync shows them as conflicts to settle.",
      "Nothing was sent. Sync again once the folder is settled.",
    ]);
    expect(
      overleafResultView(synced({ outcome: "attention", publication: attention })).lines[0],
    ).toBe("A file or a kept copy changed while Overleaf's changes were written. Check it.");
    // Stopped only at conflict marks in held files: everything else came in and went out.
    const marksOnly = overleafResultView(
      synced({ review: incoming, outcome: "attention", markerPaths: ["main.tex"] }),
    );
    expect(marksOnly.title).toBe("1 file came in, 1 was sent");
    // A complete apply held back by a forced conflict sent nothing, renamed nothing.
    const held = overleafResultView(synced({ review: incoming, publication: attention }));
    expect(held.title).toBe("1 file came in");
    expect(held.lines).toEqual([
      "Nothing was sent: part of the folder needs attention first. Settle it, then sync again.",
    ]);
  });

  it("adds the lines of design section 4.1", () => {
    const view = overleafResultView(
      synced({
        review: review({
          outgoing: [{ kind: "renamed", from: "a.tex", to: "b.tex" }],
          warnings: [
            { kind: "rename", from: "a.tex", to: "b.tex" },
            { kind: "restores-older-version", path: "c.tex" },
            { kind: "unresolved-publication", attemptNumber: 2 },
            { kind: "over-recommended-size", bytes: 1 },
            { kind: "too-large-to-edit", path: "big.tex", bytes: 1 },
          ],
        }),
        activity: [{ threadId: "t2", title: "Fix figures" }],
        linkedElsewhere: true,
      }),
    );
    expect(view.lines).toEqual([
      "Renamed a.tex to b.tex. Overleaf drops comments and tracked changes on renamed files.",
      "Sent a version of c.tex that Overleaf had before.",
      "An earlier send never got an answer. Scient never retries it, and Overleaf still doesn't show whether it arrived; this sync may carry some of the same changes again.",
      "The project is bigger than Overleaf recommends.",
      "big.tex is too big to edit on Overleaf.",
      "Synced the main copy. Your edits in this worktree aren't in it until they're merged there.",
      "Another agent is working in this copy: Fix figures.",
    ]);
  });

  it("never claims no agent is working when activity couldn't be read", () => {
    expect(overleafResultView(synced({ activity: null })).lines).toContain(
      "Scient couldn't check whether other agents are working in this copy.",
    );
  });

  it("says when a sync first finished an interrupted one or ran again, never claiming nothing changed", () => {
    const settled = { outcome: "complete", interrupted: 0, markerPaths: [] };
    const stopped = overleafResultView({
      _tag: "needs-decision",
      retried: true,
      settled,
      review: review({ needsDecision: true }),
      activity: null,
      linkedElsewhere: false,
    });
    expect(stopped.lines.slice(0, 2)).toEqual([
      "It first finished an interrupted sync, which wrote the folder.",
      "Overleaf changed while sending, so it ran again; the first run's changes are in the folder.",
    ]);
    expect(stopped.lines.join(" ")).not.toContain("Nothing was changed");
    const cancelled = overleafResultView({
      _tag: "cancelled",
      stage: "before-prepare",
      retried: false,
      settled,
    });
    expect(cancelled.lines).toEqual([
      "It first finished an interrupted sync, which wrote the folder.",
    ]);
    const refused = overleafResultView({
      _tag: "refused",
      refusal: { reason: "unreachable" },
      retried: false,
      settled: { ...settled, outcome: "replan" },
    });
    expect(refused.lines[0]).toBe(
      "It first settled an interrupted sync without finishing it; sync again.",
    );
  });

  it("a conflict needs a decision; refusals and failures say why", () => {
    const decision = overleafResultView({
      _tag: "needs-decision",
      retried: false,
      settled: null,
      review: review({
        conflicts: [{ key: "k", paths: ["main.tex"], allowed: ["mine", "theirs"], chosen: null }],
      }),
      activity: [],
      linkedElsewhere: false,
    });
    expect(decision).toMatchObject({ title: "1 conflict with Overleaf", needsDecision: true });
    expect(
      overleafResultView({
        _tag: "refused",
        refusal: { reason: "unreachable" },
        retried: false,
        settled: null,
      }).lines[0],
    ).toBe("Overleaf couldn't be reached. Check the connection and sync again.");
    expect(
      overleafResultView({
        _tag: "unsettled",
        reason: "folder-kept-changing",
        retried: false,
        settled: null,
      }).tone,
    ).toBe("error");
  });

  it("never says nothing changed after it settled an interrupted sync", () => {
    for (const refusal of [{ reason: "editor-unsaved" }, { reason: "records-unreadable" }]) {
      const { lines } = overleafResultView({
        _tag: "refused",
        refusal,
        retried: false,
        settled: { outcome: "complete", interrupted: 0, markerPaths: [] },
      });
      expect(lines).toHaveLength(2);
      expect(lines.join(" ")).not.toMatch(/nothing was (linked or )?changed/iu);
    }
    expect(refusalText({ reason: "editor-unsaved" })).toMatch(/nothing was changed/u);
    const chip = overleafChipView(status(), false, {
      _tag: "refused",
      refusal: { reason: "records-unreadable" },
      retried: false,
      settled: { outcome: "complete", interrupted: 0, markerPaths: [] },
    });
    expect(chip.detail).not.toMatch(/nothing was (linked or )?changed/iu);
  });
});

describe("refusalText", () => {
  it("names the path when there is one, and never drops an unknown reason", () => {
    expect(refusalText({ reason: "file-too-large", path: "data.bin" })).toBe(
      "A file is over Overleaf's 50 MB limit (data.bin).",
    );
    expect(
      refusalText({ reason: "path-alias", paths: ["Figure.png", "figure.png"], path: "x" }),
    ).toBe(
      "Two names differ only by letter case or accents (Figure.png, figure.png). Rename one and sync again.",
    );
    expect(refusalText({ reason: "something-new" })).toBe("Sync stopped (something-new).");
    expect(refusalText({ reason: "something-new", message: "The server's words." })).toBe(
      "The server's words.",
    );
    // Every reason the server sends has its own words.
    for (const reason of [
      // Refused operations, by error.
      "workspace-not-authorized",
      "token-missing",
      "token-invalid",
      "project-invalid",
      "access-denied",
      "project-not-found",
      "unreachable",
      "rate-limited",
      "git-unavailable",
      "git-failed",
      "editor-unsaved",
      "operation-active",
      "missing",
      "corrupt",
      "unsupported",
      "archived",
      "folder-changed",
      "recovery-required",
      "authority-changed",
      "retained-limit",
      "checkout-suspended",
      "checkout-recovery-required",
      "unreadable-record",
      "newer-unfinished-record",
      "state-locked",
      "connection-stale",
      "connection-unavailable",
      "request-reused",
      "volume-unavailable",
      "no-volume-identity",
      "unsupported-filesystem",
      "network-filesystem",
      "volatile-filesystem",
      "sync-managed-folder",
      "read-only-parent",
      "shared-parent",
      "disk-root-checkout",
      "unsafe-directory",
      "vault-missing",
      "vault-replaced",
      // Refused reviews.
      "would-empty-overleaf",
      "remote-file-limit",
      "remote-too-large",
      "remote-file-too-large",
      "remote-forbidden",
      "path-alias",
      "unreviewed-path",
      "alias-rename",
      "candidate-file-limit",
      "candidate-too-large",
      "candidate-file-too-large",
      "local-only-limit",
      "held-file-clash",
      "release-held",
      "remote-collides-with-excluded",
      "walk-limit",
      "managed-limit",
      "total-too-large",
      "file-too-large",
      "unstable",
      "unreadable",
      "not-a-file",
      "lfs-pointer",
      "managed-excluded",
      "alias",
      "not-selectable",
      "not-local-only",
      // Links, and syncs that couldn't settle.
      "folder-invalid",
      "folder-missing",
      "folder-not-empty",
      "folder-outside-checkout",
      "folder-overlaps",
      "project-already-linked",
      "no-branch",
      "local-work-pending",
      "request-incomplete",
      "records-unreadable",
      "overleaf-moved",
      "folder-kept-changing",
      "recovery-repeated",
    ])
      expect(refusalText({ reason })).not.toContain("Sync stopped (");
    expect(
      overleafResultView({
        _tag: "cancelled",
        stage: "before-apply",
        retried: false,
        settled: null,
      }),
    ).toMatchObject({
      title: "Sync cancelled",
      lines: ["Nothing was changed."],
    });
    expect(operationErrorText({ reason: "token-missing", message: "x" })).toContain(
      "No Overleaf token is saved",
    );
    // A reason this release doesn't know, or a limit, says what the server said.
    expect(
      operationErrorText({
        _tag: "ScientOverleafOperationError",
        reason: "brand-new",
        message: "Something new happened.",
      }),
    ).toBe("Something new happened.");
    expect(
      operationErrorText({
        _tag: "ScientOverleafOperationError",
        reason: "retained-limit",
        message: "Release kept copies first.",
      }),
    ).toBe("Release kept copies first.");
    // Overleaf's rate limit is not a refused project.
    expect(operationErrorText({ reason: "rate-limited" })).toBe(
      "Overleaf is limiting Git requests right now. Nothing was lost. Sync again in a minute.",
    );
    expect(operationErrorText({ reason: "rate-limited" }, "connect")).toBe(
      "Overleaf is limiting Git requests right now. Nothing was lost. Try connecting again in a minute.",
    );
    // A typed refusal keeps its reason and path; anything else gets one fixed line.
    expect(
      operationErrorText({
        _tag: "ScientOverleafOperationError",
        reason: "access-denied",
        message: "Overleaf refused the token.",
      }),
    ).toBe(
      "Overleaf refused this project. Check the link, that the project is shared with your account, and your Overleaf token in Settings ▸ Synced folders.",
    );
    // The server saved the folder's editors first and names the files that couldn't save.
    expect(
      operationErrorText({
        _tag: "ScientOverleafOperationError",
        reason: "editor-unsaved",
        message:
          "paper/main.tex was deleted while its editor held unsaved edits. Keep or discard those edits in the editor, then try again.",
        paths: ["paper/main.tex"],
      }),
    ).toBe(
      "paper/main.tex was deleted while its editor held unsaved edits. Keep or discard those edits in the editor, then try again.",
    );
    // Only a window that didn't answer: no file to name.
    expect(operationErrorText({ reason: "editor-unsaved", message: "x", paths: [] })).toContain(
      "didn't answer the request to save its editors",
    );
    // A reason this screen has no words for shows the server's sentence, not its code.
    expect(
      operationErrorText({
        _tag: "ScientOverleafOperationError",
        reason: "volume-unavailable",
        message: "The disk holding this project is not connected.",
      }),
    ).toBe("The disk holding this project is not connected.");
    expect(
      operationErrorText({
        reason: "unrecognized-failure",
        message: "https://host/private?token=secret",
      }),
    ).toBe("Sync stopped (unrecognized-failure).");
    expect(
      operationErrorText({
        reason: "volume-unavailable",
        message: "https://host/private?token=secret",
      }),
    ).toBe("The disk holding this project is not connected.");
    for (const raw of [
      new Error("Failed to fetch remote environment endpoint https://host:3773/api/x (TypeError)"),
      { reason: "https://host/x" },
      { _tag: "EnvironmentInternalError", message: '{"cause":"boom"}' },
      "boom",
    ])
      expect(operationErrorText(raw)).toBe(OVERLEAF_REQUEST_FAILED);
  });
});

describe("choicesFor", () => {
  it("sends a choice only for a conflict that allows it", () => {
    const current = review({
      conflicts: [
        { key: "a", paths: ["a.tex"], allowed: ["mine", "theirs", "markers"], chosen: null },
        { key: "b", paths: ["b/"], allowed: ["mine", "theirs"], chosen: "theirs" },
        { key: "c", paths: ["c.tex"], allowed: ["mine", "theirs"], chosen: null },
      ],
    });
    expect(
      choicesFor(
        current,
        new Map([
          ["a", "markers"],
          ["c", "markers"],
        ]),
      ),
    ).toEqual([
      { key: "a", choice: "markers" },
      { key: "b", choice: "theirs" },
    ]);
  });
});

describe("conflict marks", () => {
  it("counts Scient's Overleaf blocks only", () => {
    const text = [
      "\\section{A}",
      "<<<<<<< Scient",
      "mine",
      "=======",
      "theirs",
      ">>>>>>> Overleaf",
      "<<<<<<< Scient:old.tex",
      "x",
      "=======",
      "y",
      ">>>>>>> Overleaf:new.tex",
    ].join("\n");
    expect(countOverleafConflictBlocks(text)).toBe(2);
    expect(countOverleafConflictBlocks("Title\n=======\n")).toBe(0);
    expect(countOverleafConflictBlocks("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n")).toBe(0);
  });

  it("reads each block's two sides, skipping a base section", () => {
    const text = [
      "a",
      "<<<<<<< Scient",
      "mine 1",
      "mine 2",
      "||||||| base",
      "base",
      "=======",
      "theirs",
      ">>>>>>> Overleaf",
      "<<<<<<< Scient",
      "unclosed",
    ].join("\r\n");
    const blocks = overleafConflictBlocks(text);
    expect(blocks).toEqual([
      { startLine: 1, endLine: 8, mine: ["mine 1", "mine 2"], theirs: ["theirs"] },
    ]);
    expect(resolvedConflictLines(blocks[0]!, "mine")).toEqual(["mine 1", "mine 2"]);
    expect(resolvedConflictLines(blocks[0]!, "theirs")).toEqual(["theirs"]);
    expect(resolvedConflictLines(blocks[0]!, "both")).toEqual(["mine 1", "mine 2", "theirs"]);
  });

  it("asks the agent to merge the files it names", () => {
    const message = askAgentMessage(["paper/main.tex"]);
    expect(message).toContain("- paper/main.tex");
    expect(message).toContain("explain your choices");
  });

  it("names files waiting for their conflicts, even when nothing else moved", () => {
    const review = {
      reviewId: "r",
      digest: "d",
      remoteTree: "a".repeat(40),
      upToDate: true,
      needsDecision: false,
      incoming: [],
      outgoing: [],
      conflicts: [],
      warnings: [],
      unresolvedMarkers: ["main.tex"],
      heldWithMarked: [],
      released: [],
      collisions: [],
      selectedAdditions: [],
      additions: [],
      localOnly: [],
    };
    const view = overleafResultView({
      _tag: "synced",
      review,
      outcome: "complete",
      interrupted: 0,
      markerPaths: [],
      publication: { _tag: "none" },
      retried: false,
      settled: null,
      activity: [],
      linkedElsewhere: false,
    });
    expect(view.title).toBe("1 file waits for conflicts");
    expect(view.lines).toContain("Waiting for conflict marks to be settled: main.tex.");
    // At a conflict too: held files are named beside it.
    expect(
      overleafResultView({
        _tag: "needs-decision",
        review: {
          ...review,
          upToDate: false,
          needsDecision: true,
          conflicts: [{ key: "k", paths: ["intro.tex"], allowed: ["mine"], chosen: null }],
        },
        retried: false,
        settled: null,
        activity: [],
        linkedElsewhere: false,
      }).lines,
    ).toContain("Waiting for conflict marks to be settled: main.tex.");
  });

  it("says when a file can't be sent anyway, and why", () => {
    expect(refusalText({ reason: "release-held", path: "guide.md" })).toBe(
      "guide.md can't be sent anyway: another file waiting for its conflicts keeps its place on Overleaf. Settle that file first.",
    );
  });

  it("says what an undo put back and left, and never calls a replan put back", () => {
    const undone = {
      _tag: "undone" as const,
      restored: ["main.tex"],
      removed: ["new.tex"],
      recreated: ["gone.tex"],
      skipped: [{ path: "notes.tex", reason: "changed" as const }],
      // The sync that follows every undo; here it had nothing more to do.
      sync: {
        _tag: "synced" as const,
        review: {
          reviewId: "r",
          digest: "d",
          remoteTree: "a".repeat(40),
          upToDate: true,
          needsDecision: false,
          incoming: [],
          outgoing: [],
          conflicts: [],
          warnings: [],
          unresolvedMarkers: [],
          heldWithMarked: [],
          released: [],
          collisions: [],
          selectedAdditions: [],
          additions: [],
          localOnly: [],
        },
        outcome: "complete",
        interrupted: 0,
        markerPaths: [],
        publication: { _tag: "none" as const },
        retried: false,
        settled: null,
        activity: [],
        linkedElsewhere: false,
      },
    };
    expect(overleafUndoView({ ...undone, outcome: "complete" })).toEqual({
      title: "Undo complete",
      lines: [
        "Removed locally: new.tex.",
        "Put back an earlier version locally: main.tex.",
        "Recreated locally: gone.tex.",
        "Left as it is: notes.tex (edited since).",
        "Up to date with Overleaf.",
      ],
      tone: "success",
      needsDecision: false,
    });
    const complete = { ...undone, outcome: "complete" as const, skipped: [] };
    expect(overleafUndoSucceeded(complete)).toBe(true);
    expect(overleafUndoSucceeded({ ...complete, skipped: undone.skipped })).toBe(false);
    expect(overleafUndoSucceeded({ ...complete, outcome: "attention" })).toBe(false);
    expect(
      overleafUndoSucceeded({ ...complete, sync: { ...complete.sync, outcome: "replan" } }),
    ).toBe(false);
    expect(
      overleafUndoSucceeded({
        ...complete,
        sync: { ...complete.sync, publication: { _tag: "unknown", attemptNumber: 1 } },
      }),
    ).toBe(false);
    expect(overleafUndoView({ ...undone, outcome: "replan" }).title).toBe("Nothing was put back");
    // Stopped partway: not synced, and it says nothing was sent.
    expect(
      overleafUndoView({
        ...undone,
        outcome: "attention",
        sync: { _tag: "not-synced", reason: "undo-incomplete" },
      }),
    ).toEqual({
      title: "Undo needs attention",
      lines: [
        "Left as it is: notes.tex (edited since).",
        "Undo stopped partway; nothing was sent. Check the files, then sync.",
      ],
      tone: "warning",
      needsDecision: false,
    });
    // A file kept only on this computer is never written by Undo, and is named.
    expect(
      overleafUndoView({
        ...undone,
        skipped: [{ path: "private.tex", reason: "kept-only-here" }],
        outcome: null,
      }).lines,
    ).toEqual(["Left as it is: private.tex (kept only here).", "Up to date with Overleaf."]);
    expect(overleafUndoView({ _tag: "cancelled" })).toMatchObject({
      title: "Undo cancelled",
      lines: ["Nothing was changed."],
    });
    expect(overleafUndoView({ _tag: "not-eligible", reason: "unresolved" }).lines).toEqual([
      "Overleaf never answered this send.",
    ]);
  });
});

describe("clean held files", () => {
  it("names their marked dependencies and keeps a held-only sync open", () => {
    const held = review({
      upToDate: true,
      unresolvedMarkers: ["b.tex"],
      heldWithMarked: [{ path: "a.tex", markedPaths: ["b.tex"] }],
    });
    const line =
      "a.tex waits with b.tex, which still has conflict marks: Scient can't tell whether the file moved. Settle b.tex, then sync again.";
    expect(reviewHeldLines(held)).toContain(line);
    const result = synced({ review: held, publication: { _tag: "none" } });
    expect(overleafResultView(result).title).toBe("2 files wait for conflicts");
    expect(overleafResultView(result).lines).toContain(line);
    // Even when the dependency has just been marked by the apply, the clean file stays visible.
    const fresh = { ...held, unresolvedMarkers: [] };
    expect(readNothingToDoLine(fresh)).toBeNull();
    expect(overleafSyncSucceeded(synced({ review: fresh, publication: { _tag: "none" } }))).toBe(
      false,
    );
    expect(
      overleafResultView({
        _tag: "needs-decision",
        review: fresh,
        retried: false,
        settled: null,
        activity: [],
        linkedElsewhere: false,
      }).lines,
    ).toContain(line);
  });
});

describe("readNothingToDoLine", () => {
  it("says up to date only when a read has nothing to bring in, send or hold", () => {
    expect(readNothingToDoLine(review({ upToDate: true }))).toBe(
      "Up to date with Overleaf: nothing to bring in or send.",
    );
    expect(readNothingToDoLine(review({ upToDate: false }))).toBeNull();
    expect(
      readNothingToDoLine(review({ upToDate: true, unresolvedMarkers: ["a.tex"] })),
    ).toBeNull();
  });
});

describe("results the folder status can't show", () => {
  it("the chip says a conflict or a refusal from the last sync before the edits waiting", () => {
    const edits = status({ local: { _tag: "read", changed: 1, deleted: 0, added: 0 } });
    expect(
      overleafChipView(edits, false, {
        _tag: "needs-decision",
        review: review(),
        retried: false,
        settled: null,
        activity: [],
        linkedElsewhere: false,
      }),
    ).toMatchObject({ state: "decision", label: "Needs a decision" });
    expect(
      overleafChipView(edits, false, {
        _tag: "refused",
        refusal: { reason: "unreadable-file", path: "a.txt" },
        retried: false,
        settled: null,
      }),
    ).toMatchObject({ state: "problem", label: "Couldn't sync" });
    expect(overleafChipView(edits, false, null).state).toBe("edits");
  });

  it("a review still to run does not list a new file kept only here as sent", () => {
    const outgoing = [
      { kind: "added" as const, path: "keep.txt" },
      { kind: "added" as const, path: "send.txt" },
      { kind: "renamed" as const, from: "a.tex", to: "b.tex" },
    ];
    expect(outgoingAfterDecisions(outgoing, new Map([["keep.txt", "keep" as const]]))).toEqual([
      { kind: "added", path: "send.txt" },
      { kind: "renamed", from: "a.tex", to: "b.tex" },
    ]);
  });
});

describe("unreadable link records", () => {
  const record = (
    kind: "damaged" | "newer",
    unfinished: boolean | null,
    setAside: "allowed" | "confirm" | "held",
    holds: "linking" | "checkout" | "every-checkout",
  ) => ({ recordId: "r1", folder: "/work/paper", kind, unfinished, setAside, holds });
  const LINKING = "Scient won't link folders.";
  const BULK = (which: string) =>
    `Scient won't link folders or change ${which} project's files in bulk, for example when switching branches.`;

  it.each([
    [
      record("newer", true, "held", "checkout"),
      "A newer version of Scient made this link, and its last sync didn't finish. Open that version to finish it; Scient keeps the record until then.",
      `Until then, ${BULK("this")}`,
      null,
    ],
    [
      record("newer", null, "held", "every-checkout"),
      "A newer version of Scient made this link, and this version can't tell whether its last sync finished. Open that version to check; Scient keeps the record until then.",
      `Until then, ${BULK("any")}`,
      null,
    ],
    [
      record("newer", false, "allowed", "linking"),
      "A newer version of Scient made this link. As far as this version can tell, its last sync finished.",
      `Until it's set aside, ${LINKING}`,
      { label: "Set aside", acceptUnfinished: false },
    ],
    [
      record("damaged", true, "confirm", "checkout"),
      "This record is damaged, and its last sync stopped part-way. Setting it aside stops Scient guarding the files that sync left in the folder.",
      `Until it's set aside, ${BULK("this")}`,
      { label: "Set aside anyway", acceptUnfinished: true },
    ],
    [
      record("damaged", false, "allowed", "linking"),
      "This record is damaged. No sync is waiting on it.",
      `Until it's set aside, ${LINKING}`,
      { label: "Set aside", acceptUnfinished: false },
    ],
    [
      record("damaged", null, "allowed", "every-checkout"),
      "This record is damaged, and it doesn't say whether a sync stopped part-way.",
      `Until it's set aside, ${BULK("any")}`,
      { label: "Set aside", acceptUnfinished: false },
    ],
  ])("says what %o holds back and how it can be set aside", (shown, state, holds, action) => {
    expect(unreadableRecordLines(shown)).toEqual({ state, holds });
    expect(setAsideAction(shown)).toEqual(action);
  });
});
