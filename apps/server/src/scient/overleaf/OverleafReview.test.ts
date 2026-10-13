// @effect-diagnostics nodeBuiltinImport:off -- Real Git repositories and manuscript folders.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { OverleafConnectionDocument } from "./OverleafConnectionState.ts";
import { overleafConnectionFixture } from "./OverleafConnectionState.testkit.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import { captureOverleafInventory, type OverleafInventoryInput } from "./OverleafInventory.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import {
  buildOverleafReview,
  overleafConflictKey,
  type OverleafReviewInput,
  type OverleafReviewResult,
} from "./OverleafReview.ts";
import type { ConflictChoice } from "./syncRules.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const paragraphs = (...values: ReadonlyArray<string>) =>
  `${["\\section{Intro}", ...values.flatMap((value) => ["", "", "", value]), "", "", "", "\\end"].join("\n")}\n`;

interface Scenario {
  /** Files in the last synced state; null for a connection that never synced. */
  readonly base: Record<string, string> | null;
  readonly local: Record<string, string>;
  readonly remote: Record<string, string>;
  readonly connection?: Partial<OverleafConnectionDocument>;
  readonly localOnly?: ReadonlyArray<string>;
}

const withScenario = <A, E>(
  scenario: Scenario,
  body: (context: {
    readonly review: (
      options?: Partial<OverleafReviewInput> & {
        readonly select?: ReadonlyArray<string>;
        readonly request?: ReadonlyArray<string>;
        readonly choices?: ReadonlyMap<string, ConflictChoice>;
      },
    ) => Effect.Effect<OverleafReviewResult, unknown>;
    readonly tree: (files: Record<string, string>) => Effect.Effect<string, unknown>;
    readonly folder: string;
    readonly connection: OverleafConnectionDocument;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-review-" }),
      );
      const git = yield* OverleafGitExecutor.make({
        runtimeRoot: NodePath.join(root, "runtime"),
        allowLocalProtocols: true,
      });
      const repos = yield* OverleafRepository.make.pipe(
        Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
      );
      const repo = NodePath.join(root, "connection.git");
      yield* repos.initialize({
        repo,
        gitUrl: "https://git.overleaf.com/0123456789abcdef01234567",
      });
      const tree = Effect.fnUntraced(function* (files: Record<string, string>) {
        const entries = [];
        for (const [path, content] of Object.entries(files))
          entries.push({ path, oid: yield* repos.writeBlob({ repo, bytes: bytes(content) }) });
        return yield* repos.writeTree({ repo, entries });
      });
      const folder = NodePath.join(root, "paper");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(folder);
        for (const [path, content] of Object.entries(scenario.local)) {
          await NodeFSP.mkdir(NodePath.dirname(NodePath.join(folder, path)), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(folder, path), content);
        }
      });
      const baseTree = scenario.base === null ? null : yield* tree(scenario.base);
      const remoteTree = yield* tree(scenario.remote);
      const remoteCommit = yield* repos.commit({
        repo,
        tree: remoteTree,
        parents: [],
        message: "o",
      });
      const connection: OverleafConnectionDocument = {
        ...overleafConnectionFixture(),
        base: { commit: null, tree: baseTree, generation: baseTree === null ? 0 : 1 },
        managedPaths: Object.keys(scenario.base ?? {}),
        localOnlyPaths: [...(scenario.localOnly ?? [])],
        ...scenario.connection,
      };
      const review = (
        options: Partial<OverleafReviewInput> & {
          readonly select?: ReadonlyArray<string>;
          readonly request?: ReadonlyArray<string>;
          readonly choices?: ReadonlyMap<string, ConflictChoice>;
        } = {},
      ) =>
        Effect.gen(function* () {
          const inventoryInput: OverleafInventoryInput = {
            folder,
            managedPaths: connection.managedPaths,
            localOnlyPaths: connection.localOnlyPaths,
            selectedAdditions: options.select ?? [],
            requestedPaths: options.request ?? [],
            stagingPaths: [],
          };
          const captured = yield* Effect.promise(() => captureOverleafInventory(inventoryInput));
          if (captured._tag !== "captured") throw new Error(captured.refusal.reason);
          return yield* buildOverleafReview({
            repo,
            connection,
            inventory: captured.inventory,
            remote: { commit: remoteCommit, tree: remoteTree },
            selectedAdditions: options.select ?? [],
            collisionPaths: options.request ?? [],
            choices: options.choices ?? new Map(),
            interrupted: [],
            markerPaths: [],
            epochs: { checkout: 1, credential: 1 },
            scratch: NodePath.join(root, "scratch"),
            ...options,
          }).pipe(Effect.provideService(OverleafRepository.OverleafRepository, repos));
        });
      return yield* body({ review, tree, folder, connection });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const reviewOf = (result: OverleafReviewResult) => {
  if (result._tag !== "review") throw new Error(`expected a review, got ${result._tag}`);
  return result.review;
};
const targetText = (review: ReturnType<typeof reviewOf>, path: string) => {
  const file = review.applyPlan.target.get(path);
  return file === undefined ? undefined : text(file.bytes);
};

describe("buildOverleafReview", () => {
  it.live("reports nothing to do when both sides match the base", () =>
    withScenario(
      {
        base: { "main.tex": "same" },
        local: { "main.tex": "same" },
        remote: { "main.tex": "same" },
      },
      ({ review }) =>
        Effect.gen(function* () {
          const built = reviewOf(yield* review());
          expect(built.upToDate).toBe(true);
          expect(built.confirmable).toBe(true);
          expect(built.warnings).toEqual([]);
          expect(built.binding.acknowledgements).toEqual([]);
        }),
    ),
  );

  it.live("first sync: sends only checked additions and remembers the rest as local-only", () =>
    withScenario(
      {
        base: null,
        local: { "main.tex": "mine", "main.aux": "aux" },
        remote: { "refs.bib": "@book{}" },
      },
      ({ review }) =>
        Effect.gen(function* () {
          const unselected = reviewOf(yield* review());
          expect(unselected.outgoing).toEqual([]);
          expect(unselected.incoming).toEqual([{ kind: "added", path: "refs.bib" }]);
          expect(unselected.binding.newLocalOnly).toEqual(["main.aux", "main.tex"]);
          expect(unselected.warnings).toEqual([{ kind: "first-sync" }]);

          const selected = reviewOf(yield* review({ select: ["main.tex"] }));
          expect(selected.outgoing).toEqual([{ kind: "added", path: "main.tex" }]);
          expect(selected.binding.newLocalOnly).toEqual(["main.aux"]);
          expect(selected.warnings).toEqual([{ kind: "first-sync" }, { kind: "no-sync-history" }]);
          expect(selected.binding.acknowledgements).toEqual(["first-sync", "no-sync-history"]);
          expect(targetText(selected, "refs.bib")).toBe("@book{}");
          expect(targetText(selected, "main.tex")).toBe("mine");
          expect(selected.digest).not.toBe(unselected.digest);
        }),
    ),
  );

  it.live("merges clean edits on both sides into one candidate", () =>
    withScenario(
      {
        base: { "main.tex": paragraphs("one", "two") },
        local: { "main.tex": paragraphs("ONE", "two") },
        remote: { "main.tex": paragraphs("one", "TWO") },
      },
      ({ review }) =>
        Effect.gen(function* () {
          const built = reviewOf(yield* review());
          expect(built.conflicts).toEqual([]);
          expect(targetText(built, "main.tex")).toBe(paragraphs("ONE", "TWO"));
          expect(built.incoming).toEqual([{ kind: "modified", path: "main.tex" }]);
          expect(built.outgoing).toEqual([{ kind: "modified", path: "main.tex" }]);
          expect([...built.applyPlan.captured.keys()]).toEqual(["main.tex"]);
        }),
    ),
  );

  it.live("asks for a choice on a conflict and builds a new review for each choice", () =>
    withScenario(
      {
        base: { "main.tex": paragraphs("one") },
        local: { "main.tex": paragraphs("mine") },
        remote: { "main.tex": paragraphs("theirs") },
      },
      ({ review }) =>
        Effect.gen(function* () {
          const open = reviewOf(yield* review());
          const [conflict] = open.conflicts;
          expect(conflict?.paths).toEqual(["main.tex"]);
          expect(conflict?.allowed).toEqual(["mine", "theirs", "markers"]);
          expect(conflict?.chosen).toBeNull();
          expect(open.confirmable).toBe(false);
          const key = overleafConflictKey(["main.tex"]);
          expect(conflict?.key).toBe(key);

          const mine = reviewOf(yield* review({ choices: new Map([[key, "mine"]]) }));
          expect(mine.confirmable).toBe(true);
          expect(mine.incoming).toEqual([]);
          expect(mine.outgoing).toEqual([{ kind: "modified", path: "main.tex" }]);

          const theirs = reviewOf(yield* review({ choices: new Map([[key, "theirs"]]) }));
          expect(theirs.outgoing).toEqual([]);
          expect(targetText(theirs, "main.tex")).toBe(paragraphs("theirs"));

          const markers = reviewOf(yield* review({ choices: new Map([[key, "markers"]]) }));
          expect(markers.applyPlan.markerPaths).toEqual(["main.tex"]);
          expect(targetText(markers, "main.tex")).toContain("<<<<<<< Scient");

          expect(new Set([open.digest, mine.digest, theirs.digest, markers.digest]).size).toBe(4);
          // An unknown key is ignored, never applied to some other group.
          const stray = reviewOf(yield* review({ choices: new Map([["stray", "mine"]]) }));
          expect(stray.confirmable).toBe(false);
        }),
    ),
  );

  it.live("is deterministic: the same inputs give the same digest under a new ID", () =>
    withScenario(
      { base: { "a.tex": "a" }, local: { "a.tex": "A" }, remote: { "a.tex": "a" } },
      ({ review }) =>
        Effect.gen(function* () {
          const first = reviewOf(yield* review());
          const second = reviewOf(yield* review());
          expect(second.digest).toBe(first.digest);
          expect(second.id).not.toBe(first.id);
        }),
    ),
  );

  it.live("captures a local-only file Overleaf now has, and reviews it as a conflict", () =>
    withScenario(
      {
        base: { "main.tex": "m" },
        local: { "main.tex": "m", "notes.txt": "my notes" },
        remote: { "main.tex": "m", "notes.txt": "their notes" },
        localOnly: ["notes.txt"],
      },
      ({ review }) =>
        Effect.gen(function* () {
          expect(yield* review()).toEqual({ _tag: "needs-capture", paths: ["notes.txt"] });
          const built = reviewOf(yield* review({ request: ["notes.txt"] }));
          expect(built.collisions).toEqual(["notes.txt"]);
          expect(built.conflicts.map((conflict) => conflict.paths)).toEqual([["notes.txt"]]);
          // Choosing Overleaf's version still captured the local bytes for retention.
          expect(built.applyPlan.captured.has("notes.txt")).toBe(true);
          expect(built.binding.newLocalOnly).toEqual([]);
        }),
    ),
  );

  it.live("captures an unchecked folder that Overleaf has a file in place of", () =>
    withScenario(
      {
        base: { "main.tex": "m" },
        local: { "main.tex": "m", "figs/a.png": "a", "figs/b.png": "b" },
        remote: { "main.tex": "m", figs: "a file now" },
      },
      ({ review }) =>
        Effect.gen(function* () {
          expect(yield* review()).toEqual({
            _tag: "needs-capture",
            paths: ["figs/a.png", "figs/b.png"],
          });
        }),
    ),
  );

  it.live("refuses when Overleaf has content where the folder has a link", () =>
    withScenario(
      {
        base: { "main.tex": "m" },
        local: { "main.tex": "m" },
        remote: { "main.tex": "m", "data.csv": "x" },
      },
      ({ review, folder }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            NodeFSP.symlink(NodePath.join(folder, "main.tex"), NodePath.join(folder, "data.csv")),
          );
          expect(yield* review()).toEqual({
            _tag: "refused",
            refusal: { reason: "remote-collides-with-excluded", path: "data.csv" },
          });
        }),
    ),
  );

  it.live("holds Overleaf's content to the limits before reading it", () =>
    withScenario(
      {
        base: { "main.tex": "m" },
        local: { "main.tex": "m" },
        remote: { "main.tex": "m", "big.pdf": "0123456789" },
      },
      ({ review }) =>
        Effect.gen(function* () {
          expect(yield* review({ limits: { fileBytes: 9 } })).toEqual({
            _tag: "refused",
            refusal: { reason: "remote-file-too-large", path: "big.pdf" },
          });
          expect(yield* review({ limits: { managedFiles: 1 } })).toEqual({
            _tag: "refused",
            refusal: { reason: "remote-file-limit" },
          });
          expect(yield* review({ limits: { totalBytes: 10 } })).toEqual({
            _tag: "refused",
            refusal: { reason: "remote-too-large" },
          });
        }),
    ),
  );

  it.live("warns about outgoing renames and restored older versions", () =>
    withScenario(
      {
        base: { "a.tex": paragraphs("text"), "b.tex": "current" },
        local: { "renamed.tex": paragraphs("text"), "b.tex": "older" },
        remote: { "a.tex": paragraphs("text"), "b.tex": "current" },
      },
      ({ review, tree, connection }) =>
        Effect.gen(function* () {
          const older = yield* tree({ "a.tex": paragraphs("text"), "b.tex": "older" });
          const built = reviewOf(
            yield* review({
              select: ["renamed.tex"],
              connection: {
                ...connection,
                priorBases: [{ commit: null, tree: older, generation: 0 }],
              },
            }),
          );
          expect(built.outgoing).toEqual(
            expect.arrayContaining([
              { kind: "renamed", from: "a.tex", to: "renamed.tex" },
              { kind: "modified", path: "b.tex" },
            ]),
          );
          expect(built.warnings).toEqual(
            expect.arrayContaining([
              { kind: "rename", from: "a.tex", to: "renamed.tex" },
              { kind: "restores-older-version", path: "b.tex" },
            ]),
          );
          expect(built.binding.acknowledgements).toEqual(
            expect.arrayContaining(["rename", "restores-older-version"]),
          );
        }),
    ),
  );

  it.live("forces a conflict for an interrupted file and flags unresolved Scient markers", () =>
    withScenario(
      {
        base: { "main.tex": "m", "half.tex": "h" },
        local: { "main.tex": "<<<<<<< Scient\nx\n=======\ny\n>>>>>>> Overleaf\n", "half.tex": "h" },
        remote: { "main.tex": "m", "half.tex": "h" },
      },
      ({ review }) =>
        Effect.gen(function* () {
          const built = reviewOf(
            yield* review({ interrupted: [["half.tex"]], markerPaths: ["main.tex"] }),
          );
          expect(built.conflicts.map((conflict) => [conflict.paths, conflict.origins])).toEqual([
            [["half.tex"], ["interrupted"]],
          ]);
          expect(built.unresolvedMarkers).toEqual(["main.tex"]);
          expect(built.upToDate).toBe(false);
        }),
    ),
  );
});
