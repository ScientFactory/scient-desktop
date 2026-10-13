// @effect-diagnostics nodeBuiltinImport:off -- Real Git, folders and applier.
/**
 * A review's plan is the applier's input. These run the real applier on the
 * plan a real review produced and check that the folder ends up as reviewed.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { overleafConnectionFixture } from "./OverleafConnectionState.testkit.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import { captureOverleafInventory } from "./OverleafInventory.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import { buildOverleafReview, overleafConflictKey, type OverleafReview } from "./OverleafReview.ts";
import type { ConflictChoice } from "./syncRules.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const paragraphs = (...values: ReadonlyArray<string>) =>
  `${["\\section{Intro}", ...values.flatMap((value) => ["", "", "", value]), "", "", "", "\\end"].join("\n")}\n`;

async function put(folder: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(folder, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(folder, path), content);
  }
}
async function contents(folder: string) {
  const out: Record<string, string> = {};
  for (const entry of await NodeFSP.readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = NodePath.relative(folder, NodePath.join(entry.parentPath, entry.name));
    out[path] = await NodeFSP.readFile(NodePath.join(folder, path), "utf8");
  }
  return out;
}

/** Git and a private repository for the duration of one test. */
const withRepos = <A, E>(
  body: (
    repos: OverleafRepository.OverleafRepository["Service"],
    runtime: string,
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtime = yield* fs.makeTempDirectoryScoped({ prefix: "scient-review-git-" });
      const git = yield* OverleafGitExecutor.make({
        runtimeRoot: NodePath.join(runtime, "runtime"),
        allowLocalProtocols: true,
      });
      const repos = yield* OverleafRepository.make.pipe(
        Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
      );
      return yield* body(repos, runtime);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** Builds a review of `folder` against `remote` over `base`, in a fresh private repository. */
const review = Effect.fnUntraced(function* (
  repos: OverleafRepository.OverleafRepository["Service"],
  input: {
    readonly root: string;
    readonly folder: string;
    readonly base: Record<string, string>;
    readonly remote: Record<string, string>;
    readonly select?: ReadonlyArray<string>;
    readonly choices?: ReadonlyMap<string, ConflictChoice>;
  },
) {
  const repo = NodePath.join(input.root, `connection-${crypto.randomUUID()}.git`);
  yield* repos.initialize({ repo, gitUrl: "https://git.overleaf.com/0123456789abcdef01234567" });
  const tree = Effect.fnUntraced(function* (files: Record<string, string>) {
    const entries = [];
    for (const [path, content] of Object.entries(files))
      entries.push({
        path,
        oid: yield* repos.writeBlob({ repo, bytes: new TextEncoder().encode(content) }),
      });
    return yield* repos.writeTree({ repo, entries });
  });
  const baseTree = yield* tree(input.base);
  const remoteTree = yield* tree(input.remote);
  const remoteCommit = yield* repos.commit({ repo, tree: remoteTree, parents: [], message: "o" });
  const connection = {
    ...overleafConnectionFixture(),
    base: { commit: null, tree: baseTree, generation: 1 },
    managedPaths: Object.keys(input.base),
  };
  const captured = yield* Effect.promise(() =>
    captureOverleafInventory({
      folder: input.folder,
      managedPaths: connection.managedPaths,
      localOnlyPaths: [],
      selectedAdditions: input.select ?? [],
      requestedPaths: [],
      stagingPaths: [],
    }),
  );
  if (captured._tag !== "captured") return yield* Effect.die(captured.refusal.reason);
  const result = yield* buildOverleafReview({
    repo,
    connection,
    inventory: captured.inventory,
    remote: { commit: remoteCommit, tree: remoteTree },
    selectedAdditions: input.select ?? [],
    collisionPaths: [],
    choices: input.choices ?? new Map(),
    interrupted: [],
    markerPaths: [],
    epochs: { checkout: 1, credential: 1 },
    scratch: NodePath.join(input.root, "scratch"),
  }).pipe(Effect.provideService(OverleafRepository.OverleafRepository, repos));
  if (result._tag !== "review") return yield* Effect.die(result._tag);
  return result.review;
});

const targetContents = (built: OverleafReview) =>
  Object.fromEntries(
    [...built.applyPlan.target].map(([path, file]) => [path, new TextDecoder().decode(file.bytes)]),
  );

describe("a review's plan, applied", () => {
  it.live("leaves the folder exactly as reviewed after a two-way merge with a rename", () =>
    withRepos((repos, root) =>
      fixture(async (h) => {
        await put(h.cwd, {
          "main.tex": paragraphs("ONE", "two"),
          "chapters/renamed.tex": paragraphs("chapter"),
          "new.tex": "new",
        });
        const built = await h.run(
          review(repos, {
            root,
            folder: h.cwd,
            base: { "main.tex": paragraphs("one", "two"), "chapter.tex": paragraphs("chapter") },
            remote: {
              "main.tex": paragraphs("one", "TWO"),
              "chapter.tex": paragraphs("chapter"),
              "refs.bib": "@book{}",
            },
            select: ["chapters/renamed.tex", "new.tex"],
          }),
        );
        expect(built.confirmable).toBe(true);
        const result = await h.apply("two-way", built.applyPlan);
        expect(result).toMatchObject({ outcome: "complete", matchesTarget: true, interrupted: [] });
        expect(await contents(h.cwd)).toEqual(targetContents(built));
        expect(await contents(h.cwd)).toEqual({
          "main.tex": paragraphs("ONE", "TWO"),
          "chapters/renamed.tex": paragraphs("chapter"),
          "new.tex": "new",
          "refs.bib": "@book{}",
        });
        // Every unit completed, so the base is what Overleaf had.
        expect([...result.base.keys()].sort()).toEqual([...built.applyPlan.remote.keys()].sort());
      }),
    ),
  );

  it.live("applies each conflict choice the review was built with", () =>
    withRepos((repos, root) =>
      fixture(async (h) => {
        const base = { "main.tex": paragraphs("one") };
        const remote = { "main.tex": paragraphs("theirs") };
        const key = overleafConflictKey(["main.tex"]);
        for (const [choice, expected] of [
          ["theirs", paragraphs("theirs")],
          ["mine", paragraphs("mine")],
        ] as const) {
          await put(h.cwd, { "main.tex": paragraphs("mine") });
          const built = await h.run(
            review(repos, { root, folder: h.cwd, base, remote, choices: new Map([[key, choice]]) }),
          );
          const result = await h.apply(`choice-${choice}`, built.applyPlan);
          expect(result.outcome).toBe("complete");
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe(expected);
        }

        await put(h.cwd, { "main.tex": paragraphs("mine") });
        const markers = await h.run(
          review(repos, {
            root,
            folder: h.cwd,
            base,
            remote,
            choices: new Map([[key, "markers"]]),
          }),
        );
        const result = await h.apply("choice-markers", markers.applyPlan);
        expect(result.markerPaths).toEqual(["main.tex"]);
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toContain(
          ">>>>>>> Overleaf",
        );
      }),
    ),
  );
});
