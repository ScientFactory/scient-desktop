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
  folderNameProblem,
  newFolderPath,
  operationErrorText,
  overleafChipView,
  overleafResultView,
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
    upToDate: false,
    needsDecision: false,
    incoming: [],
    outgoing: [],
    conflicts: [],
    warnings: [],
    unresolvedMarkers: [],
    collisions: [],
    selectedAdditions: [],
    ...overrides,
  };
}

function synced(
  overrides: Partial<Extract<ScientOverleafSyncResult, { _tag: "synced" }>> = {},
): ScientOverleafSyncResult {
  return {
    _tag: "synced",
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
    expect(blocked.title).toBe("Up to date with Overleaf");
    expect(blocked.lines[0]).toBe(
      "Nothing was sent: 1 file still has conflict marks. Settle them and sync again.",
    );
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

  it("a conflict needs a decision; refusals and failures say why", () => {
    const decision = overleafResultView({
      _tag: "needs-decision",
      review: review({
        conflicts: [{ key: "k", paths: ["main.tex"], allowed: ["mine", "theirs"], chosen: null }],
      }),
      activity: [],
      linkedElsewhere: false,
    });
    expect(decision).toMatchObject({ title: "1 conflict with Overleaf", needsDecision: true });
    expect(
      overleafResultView({ _tag: "refused", refusal: { reason: "unreachable" } }).lines[0],
    ).toBe("Overleaf couldn't be reached. Check the connection and sync again.");
    expect(overleafResultView({ _tag: "unsettled", reason: "folder-kept-changing" }).tone).toBe(
      "error",
    );
  });
});

describe("refusalText", () => {
  it("names the path when there is one, and never drops an unknown reason", () => {
    expect(refusalText({ reason: "file-too-large", path: "data.bin" })).toBe(
      "A file is over Overleaf's 50 MB limit (data.bin).",
    );
    expect(refusalText({ reason: "something-new" })).toBe("Sync stopped (something-new).");
    expect(operationErrorText({ reason: "token-missing", message: "x" })).toContain(
      "No Overleaf token is saved",
    );
    expect(operationErrorText(new Error("boom"))).toBe("boom");
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

  it("asks the agent to merge the files it names", () => {
    const message = askAgentMessage(["paper/main.tex"]);
    expect(message).toContain("- paper/main.tex");
    expect(message).toContain("explain your choices");
  });
});
