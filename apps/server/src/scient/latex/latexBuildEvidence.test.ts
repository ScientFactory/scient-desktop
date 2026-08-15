import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  EMPTY_EVIDENCE_MARKS,
  MAX_EVIDENCE_DEPENDENCIES,
  MISSING_FILE_DIGEST,
  UNVERIFIED_FILE_DIGEST,
  collectLatexBuildEvidence,
  decodeLatexBuildEvidence,
  encodeLatexBuildEvidence,
  latexEvidenceMatches,
  probeLatexEvidence,
} from "./latexBuildEvidence.ts";

const ROOT =
  "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n";
const INTRO = "The introduction.\n";

const makeWorkspace = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "scient-latex-evidence-",
    });
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(workspaceRoot, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fileSystem.writeFileString(absolutePath, contents);
    }
    return workspaceRoot;
  });

/**
 * A workspace whose files can be *present and unreadable*, which is the one
 * state a real temporary directory cannot be put into portably and the one
 * this module's hardest bug lives in. `locked` stands for every way a file on
 * Windows answers `EBUSY`/`EACCES` while existing perfectly well: another
 * writer holding it, an antivirus scan, a OneDrive placeholder mid-sync.
 */
type FakeEntry = { readonly kind: "file"; readonly contents: string } | { readonly kind: "locked" };

const FAKE_WORKSPACE_ROOT = "/workspace";

const systemErrorOf = (reason: "NotFound" | "PermissionDenied", method: string, path: string) =>
  PlatformError.systemError({
    _tag: reason,
    module: "FileSystem",
    method,
    description:
      reason === "NotFound" ? "no such file or directory" : "EBUSY: resource busy or locked",
    pathOrDescriptor: path,
  });

/**
 * `mtime` is deliberately absent, which is a state the real `stat` can return
 * and the one that puts the most weight on the digest: with no timestamp to
 * shortcut on, every question about a same-size file goes to the bytes.
 */
const fakeInfoOf = (contents: string): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(new TextEncoder().encode(contents).byteLength),
  blksize: Option.none(),
  blocks: Option.none(),
});

/**
 * Matched by suffix rather than by exact string: `Path.resolve` answers with
 * backslashes on Windows and forward slashes elsewhere, and the fixture should
 * not have to know which host it is running on.
 */
const fakeFileSystemLayer = (files: Readonly<Record<string, FakeEntry>>) => {
  const lookup = (absolutePath: string): FakeEntry | null => {
    const normalized = absolutePath.replaceAll("\\", "/");
    for (const [relativePath, entry] of Object.entries(files)) {
      if (normalized.endsWith(`/${relativePath}`)) return entry;
    }
    return null;
  };
  return Layer.merge(
    FileSystem.layerNoop({
      stat: (path: string): Effect.Effect<FileSystem.File.Info, PlatformError.PlatformError> => {
        const entry = lookup(path);
        if (entry === null) return Effect.fail(systemErrorOf("NotFound", "stat", path));
        if (entry.kind === "locked")
          return Effect.fail(systemErrorOf("PermissionDenied", "stat", path));
        return Effect.succeed(fakeInfoOf(entry.contents));
      },
      readFile: (path: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> => {
        const entry = lookup(path);
        if (entry === null) return Effect.fail(systemErrorOf("NotFound", "readFile", path));
        if (entry.kind === "locked")
          return Effect.fail(systemErrorOf("PermissionDenied", "readFile", path));
        return Effect.succeed(new TextEncoder().encode(entry.contents));
      },
    }),
    Path.layer,
  );
};

/**
 * The same, except `stat` always answers and only the read is refused — the
 * shape a file takes when the lock lands in the window between the two calls,
 * and the one that reaches `digestOf` rather than `statOf`.
 */
const readOnlyFailingFileSystemLayer = (
  files: Readonly<Record<string, string>>,
  unreadable: ReadonlySet<string>,
) => {
  const suffixMatch = (absolutePath: string, relativePath: string) =>
    absolutePath.replaceAll("\\", "/").endsWith(`/${relativePath}`);
  const entries = Object.entries(files);
  return Layer.merge(
    FileSystem.layerNoop({
      stat: (path: string): Effect.Effect<FileSystem.File.Info, PlatformError.PlatformError> => {
        const found = entries.find(([relativePath]) => suffixMatch(path, relativePath));
        if (found === undefined) return Effect.fail(systemErrorOf("NotFound", "stat", path));
        return Effect.succeed(fakeInfoOf(found[1]));
      },
      readFile: (path: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> => {
        const found = entries.find(([relativePath]) => suffixMatch(path, relativePath));
        if (found === undefined) return Effect.fail(systemErrorOf("NotFound", "readFile", path));
        if ([...unreadable].some((relativePath) => suffixMatch(path, relativePath)))
          return Effect.fail(systemErrorOf("PermissionDenied", "readFile", path));
        return Effect.succeed(new TextEncoder().encode(found[1]));
      },
    }),
    Path.layer,
  );
};

const collectFake = (dependencies: ReadonlyArray<string>) =>
  collectLatexBuildEvidence({
    workspaceRoot: FAKE_WORKSPACE_ROOT,
    rootRelativePath: "main.tex",
    dependencies,
    truncated: false,
    nowEpochMs: 1_700_000_000_000,
  });

const collect = (input: {
  readonly workspaceRoot: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly truncated?: boolean;
}) =>
  collectLatexBuildEvidence({
    workspaceRoot: input.workspaceRoot,
    rootRelativePath: "main.tex",
    dependencies: input.dependencies,
    truncated: input.truncated ?? false,
    nowEpochMs: 1_700_000_000_000,
  });

describe("latexBuildEvidence", () => {
  it.effect("records every dependency by content and survives a round trip through JSON", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspace({
        "main.tex": ROOT,
        "sections/intro.tex": INTRO,
      });
      const { evidence } = yield* collect({
        workspaceRoot,
        // The root arrives from the caller too; it must not be counted twice.
        dependencies: ["sections/intro.tex", "main.tex"],
      });

      expect(evidence.schemaVersion).toBe(1);
      expect(evidence.truncated).toBe(false);
      expect(evidence.dependencies.map((dependency) => dependency.path)).toEqual([
        "main.tex",
        "sections/intro.tex",
      ]);
      for (const dependency of evidence.dependencies) {
        expect(dependency.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(dependency.byteLength).toBeGreaterThan(0);
      }

      const restored = decodeLatexBuildEvidence(encodeLatexBuildEvidence(evidence));
      expect(restored).toEqual(evidence);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("refuses a state file it cannot read rather than guessing at it", () => {
    // Every binding written before this check existed has no evidence file at
    // all, and a half-written one is no better; both mean "rebuild once".
    expect(decodeLatexBuildEvidence("")).toBeNull();
    expect(decodeLatexBuildEvidence("{ not json")).toBeNull();
    expect(decodeLatexBuildEvidence(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
    expect(
      decodeLatexBuildEvidence(
        JSON.stringify({
          schemaVersion: 1,
          rootRelativePath: "main.tex",
          recordedAtEpochMs: 0,
          truncated: false,
        }),
      ),
    ).toBeNull();
  });

  it.effect("marks a dependency the compile read that is no longer there", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspace({ "main.tex": ROOT });
      const { evidence } = yield* collect({
        workspaceRoot,
        dependencies: ["sections/never-existed.tex"],
      });

      const absent = evidence.dependencies.find(
        (dependency) => dependency.path === "sections/never-existed.tex",
      );
      // A file that was already gone keeps its place: "the chapter was deleted"
      // is a change, and the only way to notice it coming back is to record it.
      expect(absent).toEqual({
        path: "sections/never-existed.tex",
        sha256: MISSING_FILE_DIGEST,
        byteLength: -1,
      });

      const probe = yield* probeLatexEvidence({
        workspaceRoot,
        evidence,
        marks: EMPTY_EVIDENCE_MARKS,
      });
      expect(probe.changed).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("answers unchanged for an untouched workspace, and cheaply after the first pass", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspace({
        "main.tex": ROOT,
        "sections/intro.tex": INTRO,
      });
      const collected = yield* collect({ workspaceRoot, dependencies: ["sections/intro.tex"] });

      // The collection pass leaves the stat marks behind, so the very first
      // probe already has everything it needs to answer without hashing.
      expect([...collected.marks.keys()].sort()).toEqual(["main.tex", "sections/intro.tex"]);

      let marks = collected.marks;
      for (let poll = 0; poll < 5; poll += 1) {
        const probe = yield* probeLatexEvidence({
          workspaceRoot,
          evidence: collected.evidence,
          marks,
        });
        expect(probe.changed).toBe(false);
        expect(probe.changedPath).toBeNull();
        marks = probe.marks;
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("sees a dependency rewritten to different bytes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* makeWorkspace({
        "main.tex": ROOT,
        "sections/intro.tex": INTRO,
      });
      const collected = yield* collect({ workspaceRoot, dependencies: ["sections/intro.tex"] });

      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "sections/intro.tex"),
        "The introduction, rewritten.\n",
      );
      const probe = yield* probeLatexEvidence({
        workspaceRoot,
        evidence: collected.evidence,
        marks: collected.marks,
      });

      expect(probe.changed).toBe(true);
      expect(probe.changedPath).toBe("sections/intro.tex");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not call a file changed for a rewrite that left the bytes alone", () =>
    Effect.gen(function* () {
      // A formatter, a checkout, a save with no edit: the timestamp moves and
      // the content does not. Rebuilding on that is a loop, not a refresh.
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* makeWorkspace({
        "main.tex": ROOT,
        "sections/intro.tex": INTRO,
      });
      const collected = yield* collect({ workspaceRoot, dependencies: ["sections/intro.tex"] });

      yield* fileSystem.writeFileString(path.join(workspaceRoot, "sections/intro.tex"), INTRO);

      // Probed with no stat memory at all — the state every dependency is in
      // on the first poll after a restart — so only the bytes can answer.
      const probe = yield* probeLatexEvidence({
        workspaceRoot,
        evidence: collected.evidence,
        marks: EMPTY_EVIDENCE_MARKS,
      });
      expect(probe.changed).toBe(false);
      // And what it verified is remembered, so the next poll is free again.
      expect(probe.marks.has("sections/intro.tex")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("sees a dependency deleted out from under a published PDF", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* makeWorkspace({
        "main.tex": ROOT,
        "sections/intro.tex": INTRO,
      });
      const collected = yield* collect({ workspaceRoot, dependencies: ["sections/intro.tex"] });

      yield* fileSystem.remove(path.join(workspaceRoot, "sections/intro.tex"));
      const probe = yield* probeLatexEvidence({
        workspaceRoot,
        evidence: collected.evidence,
        marks: collected.marks,
      });

      expect(probe.changed).toBe(true);
      expect(probe.changedPath).toBe("sections/intro.tex");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("narrows to the root alone rather than tracking more than it will check", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspace({ "main.tex": ROOT });
      const { evidence } = yield* collect({
        workspaceRoot,
        dependencies: [],
        // What the recorder manifest reports when a run named too many inputs.
        truncated: true,
      });

      expect(evidence.truncated).toBe(true);
      expect(evidence.dependencies.map((dependency) => dependency.path)).toEqual(["main.tex"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  describe("a file that is there and cannot be read", () => {
    it.effect("records it unverified rather than missing when the stat itself is refused", () =>
      Effect.gen(function* () {
        const { evidence } = yield* collectFake(["sections/intro.tex"]);
        expect(evidence.dependencies).toEqual([
          { path: "main.tex", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), byteLength: 18 },
          { path: "sections/intro.tex", sha256: UNVERIFIED_FILE_DIGEST, byteLength: -1 },
        ]);
      }).pipe(
        Effect.provide(
          fakeFileSystemLayer({
            "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
            "sections/intro.tex": { kind: "locked" },
          }),
        ),
      ),
    );

    it.effect("records it unverified when only the read is refused", () =>
      Effect.gen(function* () {
        const { evidence } = yield* collectFake(["sections/intro.tex"]);
        const intro = evidence.dependencies.find(
          (dependency) => dependency.path === "sections/intro.tex",
        );
        expect(intro).toEqual({
          path: "sections/intro.tex",
          sha256: UNVERIFIED_FILE_DIGEST,
          byteLength: -1,
        });
      }).pipe(
        Effect.provide(
          readOnlyFailingFileSystemLayer(
            { "main.tex": "\\documentclass{a}\n", "sections/intro.tex": "intro\n" },
            new Set(["sections/intro.tex"]),
          ),
        ),
      ),
    );

    it.effect("still records a genuinely absent file as missing", () =>
      Effect.gen(function* () {
        const { evidence } = yield* collectFake(["sections/deleted.tex"]);
        const deleted = evidence.dependencies.find(
          (dependency) => dependency.path === "sections/deleted.tex",
        );
        expect(deleted).toEqual({
          path: "sections/deleted.tex",
          sha256: MISSING_FILE_DIGEST,
          byteLength: -1,
        });
      }).pipe(
        Effect.provide(
          fakeFileSystemLayer({ "main.tex": { kind: "file", contents: "\\documentclass{a}\n" } }),
        ),
      ),
    );

    it.effect("never rebuilds on an unverified dependency, however the file later reads", () =>
      // The loop this closes: the lock is recorded, the lock lifts, and the
      // next poll finds a perfectly readable file where the evidence says
      // nothing was established. Under the old code that read as a change, and
      // the rebuild hit the same lock, and so on every 1.5 seconds forever.
      Effect.gen(function* () {
        const locked = yield* collectFake(["sections/intro.tex"]).pipe(
          Effect.provide(
            fakeFileSystemLayer({
              "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
              "sections/intro.tex": { kind: "locked" },
            }),
          ),
        );

        // Same evidence, probed against a workspace where the file reads fine
        // and holds bytes the evidence never saw.
        const probe = yield* probeLatexEvidence({
          workspaceRoot: FAKE_WORKSPACE_ROOT,
          evidence: locked.evidence,
          marks: locked.marks,
        }).pipe(
          Effect.provide(
            fakeFileSystemLayer({
              "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
              "sections/intro.tex": { kind: "file", contents: "something else entirely\n" },
            }),
          ),
        );

        expect(probe.changed).toBe(false);
        expect(probe.changedPath).toBeNull();
      }),
    );

    it.effect("does not call a locked dependency changed on a probe", () =>
      Effect.gen(function* () {
        const collected = yield* collectFake(["sections/intro.tex"]).pipe(
          Effect.provide(
            fakeFileSystemLayer({
              "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
              "sections/intro.tex": { kind: "file", contents: "intro\n" },
            }),
          ),
        );

        const probe = yield* probeLatexEvidence({
          workspaceRoot: FAKE_WORKSPACE_ROOT,
          evidence: collected.evidence,
          marks: EMPTY_EVIDENCE_MARKS,
        }).pipe(
          Effect.provide(
            fakeFileSystemLayer({
              "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
              "sections/intro.tex": { kind: "locked" },
            }),
          ),
        );

        expect(probe.changed).toBe(false);
      }),
    );

    it.effect("does not call it changed when only the probe's read is refused", () =>
      Effect.gen(function* () {
        const files = { "main.tex": "\\documentclass{a}\n", "sections/intro.tex": "intro\n" };
        const collected = yield* collectFake(["sections/intro.tex"]).pipe(
          Effect.provide(readOnlyFailingFileSystemLayer(files, new Set())),
        );

        // No marks, so the probe has to reach for the bytes — and the read is
        // the call that fails.
        const probe = yield* probeLatexEvidence({
          workspaceRoot: FAKE_WORKSPACE_ROOT,
          evidence: collected.evidence,
          marks: EMPTY_EVIDENCE_MARKS,
        }).pipe(
          Effect.provide(readOnlyFailingFileSystemLayer(files, new Set(["sections/intro.tex"]))),
        );

        expect(probe.changed).toBe(false);
      }),
    );

    it.effect("keeps the recorded digest, so a real edit is still caught afterwards", () =>
      // An unreadable poll must not weaken the evidence: once the file reads
      // again, it is checked against the digest it always had.
      Effect.gen(function* () {
        const collected = yield* collectFake(["sections/intro.tex"]).pipe(
          Effect.provide(
            fakeFileSystemLayer({
              "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
              "sections/intro.tex": { kind: "file", contents: "intro\n" },
            }),
          ),
        );

        const duringLock = yield* probeLatexEvidence({
          workspaceRoot: FAKE_WORKSPACE_ROOT,
          evidence: collected.evidence,
          marks: collected.marks,
        }).pipe(
          Effect.provide(
            fakeFileSystemLayer({
              "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
              "sections/intro.tex": { kind: "locked" },
            }),
          ),
        );
        expect(duringLock.changed).toBe(false);

        const afterEdit = yield* probeLatexEvidence({
          workspaceRoot: FAKE_WORKSPACE_ROOT,
          evidence: collected.evidence,
          marks: duringLock.marks,
        }).pipe(
          Effect.provide(
            fakeFileSystemLayer({
              "main.tex": { kind: "file", contents: "\\documentclass{a}\n" },
              "sections/intro.tex": { kind: "file", contents: "a real edit\n" },
            }),
          ),
        );
        expect(afterEdit.changed).toBe(true);
        expect(afterEdit.changedPath).toBe("sections/intro.tex");
      }),
    );
  });

  describe("latexEvidenceMatches", () => {
    const base = {
      schemaVersion: 1 as const,
      rootRelativePath: "main.tex",
      recordedAtEpochMs: 1_700_000_000_000,
      truncated: false,
      dependencies: [{ path: "main.tex", sha256: "abc", byteLength: 3 }],
    };

    it("ignores when the measurement was taken", () => {
      expect(latexEvidenceMatches(base, { ...base, recordedAtEpochMs: 42 })).toBe(true);
    });

    it("separates records that differ in any part of a dependency's identity", () => {
      expect(
        latexEvidenceMatches(base, {
          ...base,
          dependencies: [{ path: "main.tex", sha256: "def", byteLength: 3 }],
        }),
      ).toBe(false);
      expect(
        latexEvidenceMatches(base, {
          ...base,
          dependencies: [{ path: "main.tex", sha256: "abc", byteLength: 4 }],
        }),
      ).toBe(false);
      expect(
        latexEvidenceMatches(base, {
          ...base,
          dependencies: [{ path: "other.tex", sha256: "abc", byteLength: 3 }],
        }),
      ).toBe(false);
      expect(latexEvidenceMatches(base, { ...base, dependencies: [] })).toBe(false);
      expect(latexEvidenceMatches(base, { ...base, truncated: true })).toBe(false);
      expect(latexEvidenceMatches(base, { ...base, rootRelativePath: "other.tex" })).toBe(false);
    });

    it.effect("answers true for two collections of an unchanged workspace", () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* makeWorkspace({
          "main.tex": ROOT,
          "sections/intro.tex": INTRO,
        });
        const first = yield* collect({ workspaceRoot, dependencies: ["sections/intro.tex"] });
        const second = yield* collect({ workspaceRoot, dependencies: ["sections/intro.tex"] });
        expect(latexEvidenceMatches(first.evidence, second.evidence)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  });

  it.effect("applies the same ceiling to a caller that hands it too many paths", () =>
    Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspace({ "main.tex": ROOT });
      const { evidence } = yield* collect({
        workspaceRoot,
        dependencies: Array.from(
          { length: MAX_EVIDENCE_DEPENDENCIES + 1 },
          (_unused, index) => `chapters/chapter${String(index)}.tex`,
        ),
      });

      expect(evidence.truncated).toBe(true);
      expect(evidence.dependencies.map((dependency) => dependency.path)).toEqual(["main.tex"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
