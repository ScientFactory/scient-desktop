import { describe, expect, it } from "@effect/vitest";

import {
  type ConflictGroup,
  type FileChange,
  advanceBase,
  applyChoices,
  applyUnits,
  canMergeInEditor,
  classifyEarlierPublish,
  closeOverRenames,
  conflictGroups,
  firstStaleFile,
  guardedPaths,
  hasConflictMarkers,
  unitOutcome,
} from "./syncRules.ts";

const tree = (entries: Record<string, string>) => new Map(Object.entries(entries));
const emptyTrees = { base: tree({}), local: tree({}), remote: tree({}), merged: tree({}) };
const plain = (map: ReadonlyMap<string, string>) => Object.fromEntries([...map].sort());

describe("closeOverRenames", () => {
  it("collects every path of a file renamed on both sides", () => {
    const renames = [
      { from: "old.tex", to: "mine.tex" },
      { from: "old.tex", to: "theirs.tex" },
      { from: "other.tex", to: "moved.tex" },
    ];
    expect(closeOverRenames(["mine.tex"], renames)).toEqual(["mine.tex", "old.tex", "theirs.tex"]);
    expect(closeOverRenames(["unrelated.tex"], renames)).toEqual(["unrelated.tex"]);
  });
});

describe("guardedPaths", () => {
  it("catches a locally edited file that a clean merge would delete", () => {
    // Git's behaviour with a half-applied rename: old.tex edited locally,
    // new.tex already present, Overleaf renamed old.tex to new.tex.
    expect(
      guardedPaths({
        base: tree({ "old.tex": "v" }),
        local: tree({ "old.tex": "v-edited", "new.tex": "v" }),
        merged: tree({ "new.tex": "v" }),
        incoming: [{ kind: "deleted", path: "old.tex" }],
      }),
    ).toEqual(["old.tex"]);
  });

  it("leaves a real rename and an unchanged deletion alone", () => {
    expect(
      guardedPaths({
        base: tree({ "old.tex": "v", "gone.tex": "g" }),
        local: tree({ "old.tex": "v-edited", "gone.tex": "g" }),
        merged: tree({ "new.tex": "v-edited" }),
        incoming: [
          { kind: "renamed", from: "old.tex", to: "new.tex" },
          { kind: "deleted", path: "gone.tex" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("conflictGroups", () => {
  it("widens a conflict to the file's paths on both sides", () => {
    const groups = conflictGroups({
      trees: emptyTrees,
      merge: [{ type: "CONFLICT (contents)", paths: ["c.tex"] }],
      guarded: [],
      interrupted: [],
      renames: [{ from: "a.tex", to: "c.tex" }],
    });
    expect(groups).toEqual([
      { paths: ["a.tex", "c.tex"], types: ["CONFLICT (contents)"], origins: ["merge"] },
    ]);
  });

  it("joins records that share a path into one decision", () => {
    const groups = conflictGroups({
      trees: emptyTrees,
      merge: [
        { type: "CONFLICT (rename/rename)", paths: ["old.tex", "mine.tex", "theirs.tex"] },
        { type: "CONFLICT (contents)", paths: ["mine.tex"] },
        { type: "CONFLICT (modify/delete)", paths: ["other.tex"] },
      ],
      guarded: ["old.tex"],
      interrupted: [["x.tex", "y.tex"]],
      renames: [],
    });
    expect(groups.map((group) => group.paths)).toEqual([
      ["mine.tex", "old.tex", "theirs.tex"],
      ["other.tex"],
      ["x.tex", "y.tex"],
    ]);
    expect(groups[0]?.origins).toEqual(["guard", "merge"]);
    expect(groups[2]?.origins).toEqual(["interrupted"]);
  });
});

describe("canMergeInEditor", () => {
  const group = (overrides: Partial<ConflictGroup>): ConflictGroup => ({
    paths: ["main.tex"],
    types: ["CONFLICT (contents)"],
    origins: ["merge"],
    ...overrides,
  });

  it("is offered for one text file with overlapping content", () => {
    expect(canMergeInEditor(group({}), () => true)).toBe(true);
  });

  it("is not offered for several paths, other conflict types, or files without markers", () => {
    expect(canMergeInEditor(group({ paths: ["a.tex", "c.tex"] }), () => true)).toBe(false);
    expect(canMergeInEditor(group({ types: ["CONFLICT (modify/delete)"] }), () => true)).toBe(
      false,
    );
    expect(canMergeInEditor(group({ origins: ["interrupted"] }), () => true)).toBe(false);
    expect(canMergeInEditor(group({}), () => false)).toBe(false);
  });
});

describe("applyChoices", () => {
  const conflicts: ReadonlyArray<ConflictGroup> = [
    {
      paths: ["mine.tex", "old.tex", "theirs.tex"],
      types: ["CONFLICT (rename/rename)"],
      origins: ["merge"],
    },
  ];
  const input = {
    merged: tree({ "mine.tex": "v", "theirs.tex": "v", "untouched.tex": "u" }),
    local: tree({ "mine.tex": "v", "untouched.tex": "u" }),
    remote: tree({ "theirs.tex": "v", "untouched.tex": "u" }),
    conflicts,
  };

  it("sets every path of the group to the chosen side, absent included", () => {
    expect(plain(applyChoices({ ...input, choices: ["mine"] }))).toEqual({
      "mine.tex": "v",
      "untouched.tex": "u",
    });
    expect(plain(applyChoices({ ...input, choices: ["theirs"] }))).toEqual({
      "theirs.tex": "v",
      "untouched.tex": "u",
    });
  });

  it("keeps the merged file when the user will resolve markers", () => {
    expect(plain(applyChoices({ ...input, choices: ["markers"] }))).toEqual(plain(input.merged));
  });
});

describe("firstStaleFile", () => {
  it("names a file that changed since capture and is about to be written", () => {
    const captured = tree({ "a.tex": "1", "b.tex": "1" });
    const target = tree({ "a.tex": "2", "b.tex": "1" });
    expect(firstStaleFile({ captured, target, current: (path) => captured.get(path) })).toBeNull();
    expect(
      firstStaleFile({ captured, target, current: (path) => (path === "a.tex" ? "edited" : "1") }),
    ).toBe("a.tex");
    // A file the sync does not touch may change freely.
    expect(
      firstStaleFile({ captured, target, current: (path) => (path === "b.tex" ? "edited" : "1") }),
    ).toBeNull();
  });
});

describe("applyUnits", () => {
  it("binds the two paths of one renamed file even when they arrive as separate changes", () => {
    const changes: ReadonlyArray<FileChange> = [
      { kind: "deleted", path: "a.tex" },
      { kind: "modified", path: "c.tex" },
      { kind: "modified", path: "other.tex" },
    ];
    expect(
      applyUnits({ changes, renames: [{ from: "a.tex", to: "c.tex" }], conflicts: [] }),
    ).toEqual([[0, 1], [2]]);
  });

  it("binds everything that came from one conflict decision", () => {
    const changes: ReadonlyArray<FileChange> = [
      { kind: "deleted", path: "mine.tex" },
      { kind: "added", path: "theirs.tex" },
      { kind: "added", path: "new.tex" },
    ];
    const conflicts: ReadonlyArray<ConflictGroup> = [
      {
        paths: ["mine.tex", "old.tex", "theirs.tex"],
        types: ["CONFLICT (rename/rename)"],
        origins: ["merge"],
      },
    ];
    expect(applyUnits({ changes, renames: [], conflicts })).toEqual([[0, 1], [2]]);
  });
});

describe("unitOutcome", () => {
  it("is done only when every part is, and interrupted when partly on disk", () => {
    expect(unitOutcome(["done", "done"])).toBe("done");
    expect(unitOutcome(["done", "skipped"])).toBe("interrupted");
    expect(unitOutcome(["skipped", "interrupted"])).toBe("interrupted");
    expect(unitOutcome(["skipped", "skipped"])).toBe("skipped");
  });
});

describe("advanceBase", () => {
  it("takes Overleaf's version for completed files", () => {
    expect(
      plain(
        advanceBase({
          before: tree({ "a.tex": "1", "b.tex": "1" }),
          remote: tree({ "a.tex": "2", "b.tex": "2" }),
          undonePaths: ["b.tex"],
          renames: [],
        }),
      ),
    ).toEqual({ "a.tex": "2", "b.tex": "1" });
  });

  it("keeps the old base for both names of a renamed file whose write failed", () => {
    // The file was renamed a.tex -> c.tex locally; Overleaf edited a.tex; the
    // write to c.tex failed. Advancing a.tex here removed the collaborator's
    // edit at the next sync.
    expect(
      plain(
        advanceBase({
          before: tree({ "a.tex": "original" }),
          remote: tree({ "a.tex": "edited-on-overleaf" }),
          undonePaths: ["c.tex"],
          renames: [{ from: "a.tex", to: "c.tex" }],
        }),
      ),
    ).toEqual({ "a.tex": "original" });
  });
});

describe("classifyEarlierPublish", () => {
  const sent = { sentTree: "T", sentCommit: "C" };

  it("recognizes a publish that is still Overleaf's head", () => {
    expect(
      classifyEarlierPublish({
        ...sent,
        remoteHeadCommit: "C",
        remoteHeadTree: "T",
        treesSince: [],
      }),
    ).toBe("accepted");
    expect(
      classifyEarlierPublish({
        ...sent,
        remoteHeadCommit: "rewritten",
        remoteHeadTree: "T",
        treesSince: [],
      }),
    ).toBe("accepted");
  });

  it("recognizes a publish that was accepted and then changed by a collaborator", () => {
    expect(
      classifyEarlierPublish({
        ...sent,
        remoteHeadCommit: "revert",
        remoteHeadTree: "old",
        treesSince: [
          { commit: "revert", tree: "old" },
          { commit: "rewritten", tree: "T" },
        ],
      }),
    ).toBe("accepted");
  });

  it("does not guess when history shows nothing", () => {
    expect(
      classifyEarlierPublish({
        ...sent,
        remoteHeadCommit: "other",
        remoteHeadTree: "X",
        treesSince: [{ commit: "other", tree: "X" }],
      }),
    ).toBe("not-established");
  });
});

describe("hasConflictMarkers", () => {
  it("detects a complete conflict", () => {
    expect(hasConflictMarkers("a\n<<<<<<< Scient\nx\n=======\ny\n>>>>>>> Overleaf\nb\n")).toBe(
      true,
    );
    expect(hasConflictMarkers("a\n=======\nb\n")).toBe(true);
    expect(hasConflictMarkers("text <<<<<<< inline\n")).toBe(false);
  });
});

describe("structural conflict groups", () => {
  it("includes descendants from all trees and keeps unrelated paths outside the choice", () => {
    const trees = {
      base: tree({ "section/removed.tex": "old" }),
      local: tree({ section: "mine", "section2.tex": "unrelated" }),
      remote: tree({ "section/intro.tex": "theirs", "section/nested/methods.tex": "methods" }),
      merged: tree({
        "section~Scient": "mine",
        "section/intro.tex": "theirs",
        "section/nested/methods.tex": "methods",
        "section2.tex": "unrelated",
      }),
    };
    const groups = conflictGroups({
      trees,
      merge: [{ type: "CONFLICT (file/directory)", paths: ["section~Scient", "section"] }],
      guarded: [],
      interrupted: [],
      renames: [],
    });
    expect(groups[0]?.paths).toEqual([
      "section",
      "section/intro.tex",
      "section/nested/methods.tex",
      "section/removed.tex",
      "section~Scient",
    ]);
    expect(
      plain(
        applyChoices({
          merged: trees.merged,
          local: trees.local,
          remote: trees.remote,
          conflicts: groups,
          choices: ["mine"],
        }),
      ),
    ).toEqual({ section: "mine", "section2.tex": "unrelated" });
    expect(
      plain(
        applyChoices({
          merged: trees.merged,
          local: trees.local,
          remote: trees.remote,
          conflicts: groups,
          choices: ["theirs"],
        }),
      ),
    ).toEqual({
      "section/intro.tex": "theirs",
      "section/nested/methods.tex": "methods",
      "section2.tex": "unrelated",
    });
    const changes: FileChange[] = [
      { kind: "added", path: "section" },
      { kind: "deleted", path: "section/intro.tex" },
      { kind: "deleted", path: "section/nested/methods.tex" },
      { kind: "modified", path: "section2.tex" },
    ];
    expect(applyUnits({ changes, renames: [], conflicts: groups })).toEqual([[0, 1, 2], [3]]);
  });

  it("closes over a subtree, a renamed child and another subtree until every decision is joined", () => {
    const trees = {
      base: tree({ "section/child.tex": "old", "appendix/moved.tex": "old" }),
      local: tree({ section: "file", appendix: "file" }),
      remote: tree({ "section/child.tex": "remote", "appendix/moved.tex": "remote" }),
      merged: tree({ "section/child.tex": "remote", "appendix/moved.tex": "remote" }),
    };
    const groups = conflictGroups({
      trees,
      merge: [
        { type: "CONFLICT (file/directory)", paths: ["section"] },
        { type: "CONFLICT (file/directory)", paths: ["appendix"] },
      ],
      guarded: [],
      interrupted: [],
      renames: [{ from: "section/child.tex", to: "appendix/moved.tex" }],
    });
    expect(groups.map((g) => g.paths)).toEqual([
      ["appendix", "appendix/moved.tex", "section", "section/child.tex"],
    ]);
  });

  it("does not join siblings merely because they share a directory", () => {
    const groups = conflictGroups({
      trees: { ...emptyTrees, local: tree({ "section/a.tex": "a", "section/b.tex": "b" }) },
      merge: [
        { type: "CONFLICT (contents)", paths: ["section/a.tex"] },
        { type: "CONFLICT (contents)", paths: ["section/b.tex"] },
      ],
      guarded: [],
      interrupted: [],
      renames: [],
    });
    expect(groups.map((g) => g.paths)).toEqual([["section/a.tex"], ["section/b.tex"]]);
  });
});

describe("remaining conflict fragments", () => {
  it.each([1, 3, 12])("detects fragments for a configured marker size of %i", (size) => {
    for (const marker of [
      "<".repeat(size) + " Scient",
      ">".repeat(size) + " Overleaf",
      "|".repeat(size) + " Base",
      "=".repeat(size),
    ]) {
      expect(hasConflictMarkers(`${marker}\n`, size)).toBe(true);
    }
  });
  it.each([0, -1, 1.5, NaN, Infinity])("rejects an invalid configured size of %s", (size) => {
    expect(() => hasConflictMarkers("text", size)).toThrow(RangeError);
  });
  it.each([
    "<<<<<<< Scient",
    ">>>>>>> Overleaf",
    "||||||| Base",
    "=======",
    "<<<<<<<",
    ">>>>>>>",
    "|||||||",
    "<<<<<<<<<<<< Scient",
    ">>>>>>>>>>>> Overleaf",
    "|||||||||||| Base",
    "============",
  ])("blocks the standalone marker %s", (marker) => {
    expect(hasConflictMarkers(`before\n${marker}\nafter\n`)).toBe(true);
    expect(hasConflictMarkers(`before\r\n${marker}\r\nafter\r\n`)).toBe(true);
  });
  it("keeps blocking after either end of an actual block is removed", () => {
    const conflicted = "<<<<<<< Scient\nmine\n=======\ntheirs\n>>>>>>> Overleaf\n";
    expect(hasConflictMarkers(conflicted.replace(/^<<<<<<<.*\n/mu, ""))).toBe(true);
    expect(hasConflictMarkers(conflicted.replace(/^>>>>>>>.*\n/mu, ""))).toBe(true);
    expect(hasConflictMarkers(conflicted.replace(/^(?:<<<<<<<|>>>>>>>).*\n/gmu, ""))).toBe(true);
    expect(hasConflictMarkers("mine and theirs\n")).toBe(false);
  });
  it.each([
    "text <<<<<<< inline",
    "% <<<<<<< Scient",
    "======= heading",
    "<<<<<< short",
    "\\section{=======}",
  ])("leaves ordinary manuscript text alone: %s", (line) => {
    expect(hasConflictMarkers(`${line}\n`)).toBe(false);
  });
});
