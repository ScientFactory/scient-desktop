// @effect-diagnostics nodeBuiltinImport:off -- Builds throwaway repositories on disk with real Git.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import {
  parseMergeTreeOutput,
  parseNameStatus,
  parsePushPorcelain,
  parseRemoteBranchAdvertisement,
} from "./OverleafRepository.ts";

import { applyChoices, applyUnits, conflictGroups, hasConflictMarkers } from "./syncRules.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const TOKEN = bytes("unused-for-local-remote");

const paragraphs = (...values: ReadonlyArray<string>) =>
  `${["\\section{Intro}", ...values.flatMap((value) => ["", "", "", value]), "", "", "", "\\end"].join("\n")}\n`;

type HarnessError =
  | OverleafRepository.OverleafRepositoryError
  | OverleafGitExecutor.OverleafGitError;

interface Harness {
  readonly repos: OverleafRepository.OverleafRepository["Service"];
  readonly git: OverleafGitExecutor.OverleafGitExecutor["Service"];
  readonly root: string;
  /** A fresh private repository. */
  readonly repo: (name: string, gitUrl?: string) => Effect.Effect<string, HarnessError>;
  /** Stores files and returns the tree id. */
  readonly tree: (
    repo: string,
    files: Record<string, string>,
  ) => Effect.Effect<string, HarnessError>;
  readonly read: (
    repo: string,
    tree: string,
  ) => Effect.Effect<Record<string, string>, HarnessError>;
}

const withHarness = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-overleaf-repo-" });
      const git = yield* OverleafGitExecutor.make({
        runtimeRoot: NodePath.join(root, "runtime"),
        allowLocalProtocols: true,
      });
      const repos = yield* OverleafRepository.make.pipe(
        Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
      );
      const harness: Harness = {
        repos,
        git,
        root,
        repo: Effect.fnUntraced(function* (
          name: string,
          gitUrl = "https://git.overleaf.com/0123456789abcdef01234567",
        ) {
          const repo = NodePath.join(root, `${name}.git`);
          yield* repos.initialize({ repo, gitUrl });
          return repo;
        }),
        tree: Effect.fnUntraced(function* (repo: string, files: Record<string, string>) {
          const entries = [];
          for (const [path, content] of Object.entries(files)) {
            entries.push({ path, oid: yield* repos.writeBlob({ repo, bytes: bytes(content) }) });
          }
          return yield* repos.writeTree({ repo, entries });
        }),
        read: Effect.fnUntraced(function* (repo: string, tree: string) {
          const out: Record<string, string> = {};
          for (const entry of yield* repos.readTree({ repo, tree })) {
            out[entry.path] = text(
              yield* repos.readBlob({ repo, oid: entry.oid, maxBytes: 1024 * 1024 }),
            );
          }
          return out;
        }),
      };
      return yield* body(harness);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("Overleaf repository output parsing", () => {
  it("reads the advertised branch", () => {
    expect(parseRemoteBranchAdvertisement("ref: refs/heads/main\tHEAD\nabc\tHEAD\n")).toBe("main");
    expect(parseRemoteBranchAdvertisement(`${"a".repeat(40)}\trefs/heads/master\n`)).toBe("master");
    expect(
      parseRemoteBranchAdvertisement(
        `${"a".repeat(40)}\trefs/heads/master\n${"b".repeat(40)}\trefs/heads/main\n`,
      ),
    ).toBeNull();
  });

  it("reads merge-tree conflict records and refuses a failure without one", () => {
    const tree = "a".repeat(40);
    expect(parseMergeTreeOutput(`${tree}\0`, false)).toEqual({ tree, conflicts: [] });
    const conflicted = [
      tree,
      `100644 ${"b".repeat(40)} 1\told.tex`,
      "",
      "3",
      "old.tex",
      "mine.tex",
      "theirs.tex",
      "CONFLICT (rename/rename)",
      "message",
      "1",
      "main.tex",
      "Auto-merging",
      "Auto-merging main.tex",
      "",
    ].join("\0");
    expect(parseMergeTreeOutput(conflicted, true)).toEqual({
      tree,
      conflicts: [
        { type: "CONFLICT (rename/rename)", paths: ["old.tex", "mine.tex", "theirs.tex"] },
      ],
    });
    expect(parseMergeTreeOutput(`${tree}\0\0`, true)).toBeNull();
    expect(parseMergeTreeOutput("not a tree\0", false)).toBeNull();
  });

  it("reads name-status records including renames", () => {
    expect(parseNameStatus("M\0a.tex\0R100\0old.tex\0new.tex\0A\0b.tex\0D\0c.tex\0")).toEqual([
      { kind: "modified", path: "a.tex" },
      { kind: "renamed", from: "old.tex", to: "new.tex" },
      { kind: "added", path: "b.tex" },
      { kind: "deleted", path: "c.tex" },
    ]);
    expect(parseNameStatus("X\0a.tex\0")).toBeNull();
  });

  it("treats only an explicit out-of-date rejection as definite", () => {
    const head = "To origin\n";
    expect(parsePushPorcelain(`${head} \tabc:refs/heads/main\tabc..def\nDone\n`, "")).toEqual({
      _tag: "accepted",
    });
    expect(
      parsePushPorcelain(`${head}!\tabc:refs/heads/main\t[rejected] (non-fast-forward)\n`, ""),
    ).toEqual({ _tag: "out-of-date" });
    expect(
      parsePushPorcelain(`${head}!\tabc:refs/heads/main\t[rejected] (fetch first)\n`, ""),
    ).toEqual({ _tag: "out-of-date" });
    expect(
      parsePushPorcelain(`${head}!\tabc:refs/heads/main\t[remote rejected] (hook declined)\n`, "")
        ._tag,
    ).toBe("unknown");
    expect(parsePushPorcelain("", "fatal: unable to access")._tag).toBe("unknown");
  });
});

describe("OverleafRepository trees", () => {
  it.effect("stores nested files and reads them back byte for byte", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const files = {
          "main.tex": "a\r\nb\n",
          "sections/intro.tex": "intro",
          "figures/f.bin": "\u0000\u0001",
        };
        const tree = yield* h.tree(repo, files);
        expect(yield* h.read(repo, tree)).toEqual(files);
        expect(yield* h.repos.diff({ repo, from: tree, to: tree })).toEqual([]);
      }),
    ),
  );

  it.effect("stores files staged on disk in one call", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repo = yield* h.repo("a");
        const first = NodePath.join(h.root, "0");
        const second = NodePath.join(h.root, "1");
        yield* fs.writeFileString(first, "one");
        yield* fs.writeFileString(second, "two");
        const oids = yield* h.repos.writeBlobsFromFiles({ repo, files: [first, second] });
        expect(oids).toHaveLength(2);
        expect(text(yield* h.repos.readBlob({ repo, oid: oids[1]!, maxBytes: 16 }))).toBe("two");
      }),
    ),
  );

  it.effect("refuses a path that is both a file and a folder", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const error = yield* h
          .tree(repo, { section: "file", "section/main.tex": "inside" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OverleafRepositoryError", reason: "invalid-tree" });
      }),
    ),
  );

  it.effect("refuses to read a tree that contains a link", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const target = yield* h.repos.writeBlob({ repo, bytes: bytes("../outside") });
        const made = yield* h.git.execute({
          cwd: repo,
          args: ["mktree"],
          stdin: bytes(`120000 blob ${target}\tlink.tex\n`),
        });
        const error = yield* h.repos
          .readTree({ repo, tree: text(made.stdout).trim() })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "unsupported-entry" });
      }),
    ),
  );
});

describe("OverleafRepository merge", () => {
  it.effect("merges separate edits and follows a rename without any checkout", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const base = yield* h.tree(repo, { "old.tex": paragraphs("one", "two", "three") });
        const local = yield* h.tree(repo, { "old.tex": paragraphs("one LOCAL", "two", "three") });
        const remote = yield* h.tree(repo, { "new.tex": paragraphs("one", "two", "three REMOTE") });
        const merged = yield* h.repos.merge({ repo, base, local, remote });
        expect(merged.conflicts).toEqual([]);
        expect(yield* h.read(repo, merged.tree)).toEqual({
          "new.tex": paragraphs("one LOCAL", "two", "three REMOTE"),
        });
        expect(yield* h.repos.diff({ repo, from: local, to: merged.tree })).toEqual([
          { kind: "renamed", from: "old.tex", to: "new.tex" },
        ]);
      }),
    ),
  );

  it.effect("merges against an explicit base even when nothing else is shared", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const empty = yield* h.tree(repo, {});
        const local = yield* h.tree(repo, { "same.tex": "same\n", "mine.tex": "mine\n" });
        const remote = yield* h.tree(repo, { "same.tex": "same\n", "theirs.tex": "theirs\n" });
        const merged = yield* h.repos.merge({ repo, base: empty, local, remote });
        expect(merged.conflicts).toEqual([]);
        expect(Object.keys(yield* h.read(repo, merged.tree)).sort()).toEqual([
          "mine.tex",
          "same.tex",
          "theirs.tex",
        ]);
      }),
    ),
  );

  it.effect("labels conflict markers and keeps unrelated edits in the same file", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const base = yield* h.tree(repo, { "main.tex": paragraphs("one", "two", "three") });
        const local = yield* h.tree(repo, { "main.tex": paragraphs("one MINE", "two", "three") });
        const remote = yield* h.tree(repo, {
          "main.tex": paragraphs("one THEIRS", "two", "three REMOTE"),
        });
        const merged = yield* h.repos.merge({ repo, base, local, remote });
        expect(merged.conflicts).toEqual([{ type: "CONFLICT (contents)", paths: ["main.tex"] }]);
        const content = (yield* h.read(repo, merged.tree))["main.tex"]!;
        expect(content).toContain(
          "<<<<<<< Scient\none MINE\n=======\none THEIRS\n>>>>>>> Overleaf",
        );
        expect(content).toContain("three REMOTE");
      }),
    ),
  );

  it.effect("reports a rename on both sides as one conflict across three paths", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const body = paragraphs("one", "two", "three");
        const base = yield* h.tree(repo, { "old.tex": body });
        const local = yield* h.tree(repo, { "mine.tex": body });
        const remote = yield* h.tree(repo, { "theirs.tex": body });
        const merged = yield* h.repos.merge({ repo, base, local, remote });
        expect(merged.conflicts).toHaveLength(1);
        expect(merged.conflicts[0]!.type).toBe("CONFLICT (rename/rename)");
        expect([...merged.conflicts[0]!.paths].sort()).toEqual([
          "mine.tex",
          "old.tex",
          "theirs.tex",
        ]);
      }),
    ),
  );

  it.effect("reports an edit against a deletion", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const base = yield* h.tree(repo, { "a.tex": paragraphs("one", "two", "three") });
        const local = yield* h.tree(repo, { "a.tex": paragraphs("one MINE", "two", "three") });
        const remote = yield* h.tree(repo, {});
        const merged = yield* h.repos.merge({ repo, base, local, remote });
        expect(merged.conflicts).toEqual([{ type: "CONFLICT (modify/delete)", paths: ["a.tex"] }]);
      }),
    ),
  );
});

describe("OverleafRepository transport", () => {
  /** A local bare repository standing in for Overleaf, seeded with one commit on `main`. */
  const overleaf = (h: Harness, files: Record<string, string>) =>
    Effect.gen(function* () {
      const remote = NodePath.join(h.root, "overleaf.git");
      yield* h.git.execute({ cwd: h.root, args: ["init", "-q", "--bare", "-b", "main", remote] });
      const seed = yield* h.repo("seed", remote);
      const tree = yield* h.tree(seed, files);
      const commit = yield* h.repos.commit({ repo: seed, tree, parents: [], message: "seed" });
      expect(yield* h.repos.push({ repo: seed, commit, branch: "main", token: TOKEN })).toEqual({
        _tag: "accepted",
      });
      return { remote, seed, commit, tree };
    });

  it.effect("discovers the branch, fetches, publishes, and recognizes an out-of-date publish", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const server = yield* overleaf(h, { "main.tex": "v1\n" });
        const repo = yield* h.repo("connection", server.remote);
        expect(yield* h.repos.discoverBranch({ repo, token: TOKEN })).toBe("main");

        const fetched = yield* h.repos.fetch({ repo, branch: "main", token: TOKEN });
        expect(fetched.commit).toBe(server.commit);
        expect(yield* h.read(repo, fetched.tree)).toEqual({ "main.tex": "v1\n" });

        const mine = yield* h.repos.commit({
          repo,
          tree: yield* h.tree(repo, { "main.tex": "v2 mine\n" }),
          parents: [fetched.commit],
          message: "Update from Scient",
        });

        // A collaborator publishes first.
        const theirs = yield* h.repos.commit({
          repo: server.seed,
          tree: yield* h.tree(server.seed, { "main.tex": "v2 theirs\n" }),
          parents: [server.commit],
          message: "collaborator",
        });
        expect(
          (yield* h.repos.push({ repo: server.seed, commit: theirs, branch: "main", token: TOKEN }))
            ._tag,
        ).toBe("accepted");

        expect(yield* h.repos.push({ repo, commit: mine, branch: "main", token: TOKEN })).toEqual({
          _tag: "out-of-date",
        });

        const again = yield* h.repos.fetch({ repo, branch: "main", token: TOKEN });
        expect(again.commit).toBe(theirs);
        const rebuilt = yield* h.repos.commit({
          repo,
          tree: yield* h.tree(repo, { "main.tex": "v3 merged\n" }),
          parents: [again.commit],
          message: "Update from Scient",
        });
        expect(
          yield* h.repos.push({ repo, commit: rebuilt, branch: "main", token: TOKEN }),
        ).toEqual({
          _tag: "accepted",
        });

        const latest = yield* h.repos.fetch({ repo, branch: "main", token: TOKEN });
        expect(
          yield* h.repos.isAncestor({ repo, ancestor: theirs, descendant: latest.commit }),
        ).toBe(true);
        expect(yield* h.repos.isAncestor({ repo, ancestor: mine, descendant: latest.commit })).toBe(
          false,
        );
        const since = yield* h.repos.treesSince({
          repo,
          after: server.commit,
          head: latest.commit,
          limit: 10,
        });
        expect(since.map((entry) => entry.commit)).toEqual([rebuilt, theirs]);
      }),
    ),
  );

  it.effect("reports an unreachable remote as an unknown publish outcome, not a failure", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("connection", NodePath.join(h.root, "missing.git"));
        const commit = yield* h.repos.commit({
          repo,
          tree: yield* h.tree(repo, { "main.tex": "x\n" }),
          parents: [],
          message: "x",
        });
        const outcome = yield* h.repos.push({ repo, commit, branch: "main", token: TOKEN });
        expect(outcome._tag).toBe("unknown");
      }),
    ),
  );

  it.effect("keeps and releases its own references", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a");
        const tree = yield* h.tree(repo, { "main.tex": "x\n" });
        expect(yield* h.repos.readRef({ repo, name: "base" })).toBeNull();
        yield* h.repos.setRef({ repo, name: "base", oid: tree });
        expect(yield* h.repos.readRef({ repo, name: "base" })).toBe(tree);
        yield* h.repos.deleteRef({ repo, name: "base" });
        expect(yield* h.repos.readRef({ repo, name: "base" })).toBeNull();
      }),
    ),
  );

  it.effect("re-points an existing repository at a new address without losing objects", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("a", "https://git.overleaf.com/aaaaaaaaaaaaaaaaaaaaaaaa");
        const tree = yield* h.tree(repo, { "main.tex": "x\n" });
        yield* h.repos.initialize({
          repo,
          gitUrl: "https://git.overleaf.com/bbbbbbbbbbbbbbbbbbbbbbbb",
        });
        expect(yield* h.read(repo, tree)).toEqual({ "main.tex": "x\n" });
        const url = yield* h.git.execute({ cwd: repo, args: ["remote", "get-url", "origin"] });
        expect(text(url.stdout).trim()).toBe("https://git.overleaf.com/bbbbbbbbbbbbbbbbbbbbbbbb");
      }),
    ),
  );
});

describe("OverleafRepository structural conflict decisions", () => {
  for (const reverse of [false, true]) {
    for (const choice of ["mine", "theirs"] as const) {
      it.effect(
        `chooses ${choice} for a ${reverse ? "remote" : "local"} file against a folder`,
        () =>
          withHarness((h) =>
            Effect.gen(function* () {
              const repo = yield* h.repo("structure");
              const base = yield* h.tree(repo, {});
              const file = { section: "file", "section2.tex": "unrelated" };
              const folder = {
                "section/intro.tex": "intro",
                "section/nested/methods.tex": "methods",
                "section2.tex": "unrelated",
              };
              const local = yield* h.tree(repo, reverse ? folder : file);
              const remote = yield* h.tree(repo, reverse ? file : folder);
              const merged = yield* h.repos.merge({ repo, base, local, remote });
              const asMap = (entries: ReadonlyArray<OverleafRepository.TreeEntry>) =>
                new Map(entries.map((e) => [e.path, e.oid]));
              const trees = {
                base: asMap(yield* h.repos.readTree({ repo, tree: base })),
                local: asMap(yield* h.repos.readTree({ repo, tree: local })),
                remote: asMap(yield* h.repos.readTree({ repo, tree: remote })),
                merged: asMap(yield* h.repos.readTree({ repo, tree: merged.tree })),
              };
              const groups = conflictGroups({
                trees,
                merge: merged.conflicts,
                guarded: [],
                interrupted: [],
                renames: [],
              });
              expect(groups).toHaveLength(1);
              expect(groups[0]?.paths).toContain("section/intro.tex");
              expect(groups[0]?.paths).toContain("section/nested/methods.tex");
              expect(groups[0]?.paths).not.toContain("section2.tex");
              const chosen = applyChoices({
                merged: trees.merged,
                local: trees.local,
                remote: trees.remote,
                conflicts: groups,
                choices: [choice],
              });
              const chosenTree = yield* h.repos.writeTree({
                repo,
                entries: [...chosen].map(([path, oid]) => ({ path, oid })),
              });
              expect(yield* h.read(repo, chosenTree)).toEqual(
                choice === "mine" ? (reverse ? folder : file) : reverse ? file : folder,
              );
              const changes = yield* h.repos.diff({ repo, from: local, to: chosenTree });
              if (changes.length)
                expect(applyUnits({ changes, renames: [], conflicts: groups })).toEqual([
                  changes.map((_, i) => i),
                ]);
            }),
          ),
      );
    }
  }

  it.effect("includes a child renamed on Overleaf in the same structural decision", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("renamed-child");
        const body = paragraphs("one", "two", "three");
        const base = yield* h.tree(repo, { "section/old.tex": body, "untouched.tex": "unrelated" });
        const local = yield* h.tree(repo, {
          section: "replacement file",
          "untouched.tex": "unrelated",
        });
        const remote = yield* h.tree(repo, {
          "section/new.tex": body,
          "section/nested/added.tex": "new child",
          "untouched.tex": "unrelated",
        });
        const merged = yield* h.repos.merge({ repo, base, local, remote });
        const asMap = (entries: ReadonlyArray<OverleafRepository.TreeEntry>) =>
          new Map(entries.map((e) => [e.path, e.oid]));
        const trees = {
          base: asMap(yield* h.repos.readTree({ repo, tree: base })),
          local: asMap(yield* h.repos.readTree({ repo, tree: local })),
          remote: asMap(yield* h.repos.readTree({ repo, tree: remote })),
          merged: asMap(yield* h.repos.readTree({ repo, tree: merged.tree })),
        };
        const renames = (yield* h.repos.diff({ repo, from: base, to: remote })).flatMap((change) =>
          change.kind === "renamed" ? [{ from: change.from, to: change.to }] : [],
        );
        expect(renames).toContainEqual({ from: "section/old.tex", to: "section/new.tex" });
        const groups = conflictGroups({
          trees,
          merge: merged.conflicts,
          guarded: [],
          interrupted: [],
          renames,
        });
        expect(groups).toHaveLength(1);
        for (const path of [
          "section",
          "section/old.tex",
          "section/new.tex",
          "section/nested/added.tex",
        ])
          expect(groups[0]?.paths).toContain(path);
        for (const choice of ["mine", "theirs"] as const) {
          const chosen = applyChoices({
            merged: trees.merged,
            local: trees.local,
            remote: trees.remote,
            conflicts: groups,
            choices: [choice],
          });
          const chosenTree = yield* h.repos.writeTree({
            repo,
            entries: [...chosen].map(([path, oid]) => ({ path, oid })),
          });
          expect(yield* h.read(repo, chosenTree)).toEqual(
            yield* h.read(repo, choice === "mine" ? local : remote),
          );
        }
      }),
    ),
  );

  it.effect("detects markers when either end of a real merged conflict is removed", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("partial-conflict");
        const base = yield* h.tree(repo, { "main.tex": "original\n" });
        const local = yield* h.tree(repo, { "main.tex": "mine\n" });
        const remote = yield* h.tree(repo, { "main.tex": "theirs\n" });
        const merged = yield* h.repos.merge({ repo, base, local, remote });
        const body = (yield* h.read(repo, merged.tree))["main.tex"]!;
        expect(hasConflictMarkers(body.replace(/^<<<<<<<.*\n/mu, ""))).toBe(true);
        expect(hasConflictMarkers(body.replace(/^>>>>>>>.*\n/mu, ""))).toBe(true);
        expect(hasConflictMarkers(body.replace(/^(?:<<<<<<<|>>>>>>>).*\n/gmu, ""))).toBe(true);
      }),
    ),
  );
});

describe("OverleafRepository Unicode path collisions", () => {
  it.effect("rejects aliases both when constructing a tree and reading a fetched tree", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("aliases");
        const first = "caf\u00e9.tex",
          second = "cafe\u0301.tex";
        const error = yield* h
          .tree(repo, { [first]: "first", [second]: "second" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid-tree");
        const one = yield* h.repos.writeBlob({ repo, bytes: bytes("first") });
        const two = yield* h.repos.writeBlob({ repo, bytes: bytes("second") });
        const raw = yield* h.git.execute({
          cwd: repo,
          args: ["mktree", "-z"],
          stdin: bytes(`100644 blob ${one}\t${first}\0` + `100644 blob ${two}\t${second}\0`),
        });
        const incomingError = yield* h.repos
          .readTree({ repo, tree: text(raw.stdout).trim() })
          .pipe(Effect.flip);
        expect(incomingError.reason).toBe("invalid-tree");
      }),
    ),
  );
  it.effect("retains a valid decomposed filename exactly as supplied", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const repo = yield* h.repo("decomposed");
        const files = { "cafe\u0301/intro.tex": "original bytes" };
        const tree = yield* h.tree(repo, files);
        expect(yield* h.read(repo, tree)).toEqual(files);
      }),
    ),
  );
});
