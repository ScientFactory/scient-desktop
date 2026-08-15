import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  EMPTY_EVIDENCE_MARKS,
  MAX_EVIDENCE_DEPENDENCIES,
  MISSING_FILE_DIGEST,
  collectLatexBuildEvidence,
  decodeLatexBuildEvidence,
  encodeLatexBuildEvidence,
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
