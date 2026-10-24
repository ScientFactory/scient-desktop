import type {
  ScientOverleafReview,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  askAgentMessage,
  choicesFor,
  connectionForPath,
  countOverleafConflictBlocks,
  overleafConflictBlocks,
  resolvedConflictLines,
  folderNameProblem,
  newFolderPath,
  OVERLEAF_REQUEST_FAILED,
  operationErrorText,
  overleafChipView,
  overleafResultView,
  overleafUndoView,
  parseOverleafProjectInput,
  refusalText,
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
    expect(newFolderPath("", " thesis ")).toBe("thesis");
    expect(newFolderPath("papers/", "thesis")).toBe("papers/thesis");
    expect(folderNameProblem("")).not.toBeNull();
    expect(folderNameProblem("a/b")).not.toBeNull();
    expect(folderNameProblem(".hidden")).not.toBeNull();
    expect(folderNameProblem("paper")).toBeNull();
  });
});

describe("overleafChipView", () => {
  it("shows up to date, edits to send, needs a decision and a problem", () => {
    expect(overleafChipView(status(), false).label).toBe("Up to date");
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
      "Sent older versions of 1 file.",
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
});

describe("refusalText", () => {
  it("names the path when there is one, and never drops an unknown reason", () => {
    expect(refusalText({ reason: "file-too-large", path: "data.bin" })).toBe(
      "A file is over Overleaf's 50 MB limit (data.bin).",
    );
    expect(refusalText({ reason: "something-new" })).toBe("Sync stopped (something-new).");
    // Step 5's newer reasons each have their own words.
    for (const reason of [
      "request-incomplete",
      "records-unreadable",
      "overleaf-moved",
      "project-invalid",
      "authority-changed",
      "access-denied",
      "project-not-found",
      "unreachable",
      "git-unavailable",
      "git-failed",
      "token-missing",
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
    // A typed refusal keeps its reason and path; anything else gets one fixed line.
    expect(
      operationErrorText({
        _tag: "ScientOverleafOperationError",
        reason: "access-denied",
        message: "Overleaf refused the token.",
      }),
    ).toBe("Overleaf refused the token, or this account has no Git access to the project.");
    // The server saved the folder's editors first and names the files that couldn't save.
    expect(
      operationErrorText({
        _tag: "ScientOverleafOperationError",
        reason: "editor-unsaved",
        message: "Open editors were not all saved.",
        paths: ["paper/main.tex", "paper/intro.tex"],
      }),
    ).toBe("paper/main.tex couldn't be saved, so nothing was changed. Save it, then try again.");
    // Only a window that didn't answer: no file to name.
    expect(operationErrorText({ reason: "editor-unsaved", message: "x", paths: [] })).toContain(
      "didn't answer the request to save its editors",
    );
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
      recreated: [],
      skipped: [{ path: "notes.tex", reason: "changed" as const }],
      sync: null,
    };
    expect(overleafUndoView({ ...undone, outcome: "complete" })).toEqual({
      title: "Put back 2 files",
      lines: ["Left as it is: notes.tex (edited since)."],
      tone: "success",
      needsDecision: false,
    });
    expect(overleafUndoView({ ...undone, outcome: "replan" }).title).toBe("Nothing was put back");
    expect(overleafUndoView({ ...undone, outcome: "attention" }).title).toBe(
      "Undo needs attention",
    );
    // A file kept only on this computer is never written by Undo, and is named.
    expect(
      overleafUndoView({
        ...undone,
        skipped: [{ path: "private.tex", reason: "kept-only-here" }],
        outcome: null,
      }).lines,
    ).toEqual(["Left as it is: private.tex (kept only here)."]);
    expect(overleafUndoView({ _tag: "cancelled" })).toMatchObject({
      title: "Undo cancelled",
      lines: ["Nothing was changed."],
    });
    expect(overleafUndoView({ _tag: "not-eligible", reason: "unresolved" }).lines).toEqual([
      "Overleaf never answered this send.",
    ]);
  });
});
