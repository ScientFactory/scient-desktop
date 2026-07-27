import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, assert, describe, expect, it, vi } from "vitest";

import * as ProcessRunner from "./processRunner";
import {
  classifySuffixMatches,
  discoverProjectScripts,
  findWorkspaceFilesBySuffixOnDisk,
  listWorkspaceDirectories,
  resolveWorkspaceFileBySuffix,
  searchWorkspaceEntries,
} from "./workspaceEntries";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(cwd: string, relativePath: string, contents = ""): void {
  const absolutePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, "utf8");
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

describe("searchWorkspaceEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns files and directories relative to cwd", async () => {
    const cwd = makeTempDir("synara-workspace-entries-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/index.ts");
    writeFile(cwd, "README.md");
    writeFile(cwd, ".git/HEAD");
    writeFile(cwd, "node_modules/pkg/index.js");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
    assert.include(paths, "README.md");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".git")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("node_modules")));
    assert.isFalse(result.truncated);
  });

  it("filters and ranks entries by query", async () => {
    const cwd = makeTempDir("synara-workspace-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

    assert.isAbove(result.entries.length, 0);
    assert.isTrue(result.entries.some((entry) => entry.path === "src/components"));
    assert.isTrue(result.entries.every((entry) => entry.path.toLowerCase().includes("compo")));
  });

  it("can restrict search results to files before ranking", async () => {
    const cwd = makeTempDir("synara-workspace-kind-filter-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/components/guide.md");

    const result = await searchWorkspaceEntries({ cwd, query: "compo", kind: "file", limit: 10 });

    assert.isAbove(result.entries.length, 0);
    assert.isTrue(result.entries.every((entry) => entry.kind === "file"));
    assert.isFalse(result.entries.some((entry) => entry.path === "src/components"));
    assert.include(
      result.entries.map((entry) => entry.path),
      "src/components/Composer.tsx",
    );
  });

  it("supports fuzzy subsequence queries for composer path search", async () => {
    const cwd = makeTempDir("synara-workspace-fuzzy-query-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
    const paths = result.entries.map((entry) => entry.path);

    assert.isAbove(result.entries.length, 0);
    assert.include(paths, "src/components");
    assert.include(paths, "src/components/Composer.tsx");
  });

  it("tracks truncation without sorting every fuzzy match", async () => {
    const cwd = makeTempDir("synara-workspace-fuzzy-limit-");
    writeFile(cwd, "src/components/Composer.tsx");
    writeFile(cwd, "src/components/composePrompt.ts");
    writeFile(cwd, "docs/composition.md");

    const result = await searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

    assert.lengthOf(result.entries, 1);
    assert.isTrue(result.truncated);
  });

  it("excludes gitignored paths for git repositories", async () => {
    const cwd = makeTempDir("synara-workspace-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
    writeFile(cwd, "src/keep.ts", "export {};");
    writeFile(cwd, "ignored.txt", "ignore me");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.notInclude(paths, "ignored.txt");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith("convex/")));
  });

  it("excludes tracked paths that match ignore rules", async () => {
    const cwd = makeTempDir("synara-workspace-tracked-gitignore-");
    runGit(cwd, ["init"]);
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");
    runGit(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
    writeFile(cwd, ".gitignore", ".convex/\n");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("disables fsmonitor and untracked cache helpers during git workspace indexing", async () => {
    const cwd = makeTempDir("synara-workspace-hardened-git-");

    const runProcessSpy = vi.spyOn(ProcessRunner, "runProcess");
    runProcessSpy.mockImplementation(async (command, args) => {
      if (command !== "git") {
        throw new Error(`Unexpected command: ${command}`);
      }
      if (args.includes("rev-parse")) {
        return {
          stdout: "true\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      if (args.includes("ls-files")) {
        return {
          stdout: "src/keep.ts\0ignored.txt\0",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      if (args.includes("check-ignore")) {
        return {
          stdout: "ignored.txt\0",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    const gitCalls = runProcessSpy.mock.calls
      .filter(([command]) => command === "git")
      .map(([, args]) => args);

    assert.include(paths, "src/keep.ts");
    assert.notInclude(paths, "ignored.txt");
    assert.deepInclude(gitCalls, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    assert.deepInclude(gitCalls, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "check-ignore",
      "--no-index",
      "-z",
      "--stdin",
    ]);
  });

  it("excludes .convex in non-git workspaces", async () => {
    const cwd = makeTempDir("synara-workspace-non-git-convex-");
    writeFile(cwd, ".convex/local-storage/data.json", "{}");
    writeFile(cwd, "src/keep.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 100 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src");
    assert.include(paths, "src/keep.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".convex/")));
  });

  it("prunes linked git worktree subtrees from the index", async () => {
    const cwd = makeTempDir("synara-workspace-worktree-");
    writeFile(cwd, "src/app.ts", "export {};");
    // A linked worktree stores its `.git` as a regular file pointer; its files
    // duplicate another checkout and must not appear in the index.
    writeFile(cwd, ".worktrees/pr1/.git", "gitdir: /elsewhere/.git/worktrees/pr1\n");
    writeFile(cwd, ".worktrees/pr1/src/app.ts", "export {};");
    writeFile(cwd, ".worktrees/pr1/src/copy-only.ts", "export {};");

    const result = await searchWorkspaceEntries({ cwd, query: "", limit: 500 });
    const paths = result.entries.map((entry) => entry.path);

    assert.include(paths, "src/app.ts");
    assert.isFalse(paths.some((entryPath) => entryPath.startsWith(".worktrees/pr1/src")));
    assert.notInclude(paths, ".worktrees/pr1/src/copy-only.ts");
  });

  it("deduplicates concurrent index builds for the same cwd", async () => {
    const cwd = makeTempDir("synara-workspace-concurrent-build-");
    writeFile(cwd, "src/components/Composer.tsx");

    let rootReadCount = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === cwd) {
        rootReadCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await Promise.all([
      searchWorkspaceEntries({ cwd, query: "", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "comp", limit: 100 }),
      searchWorkspaceEntries({ cwd, query: "src", limit: 100 }),
    ]);

    assert.equal(rootReadCount, 1);
  });

  it("limits concurrent directory reads while walking the filesystem", async () => {
    const cwd = makeTempDir("synara-workspace-read-concurrency-");
    for (let index = 0; index < 80; index += 1) {
      writeFile(cwd, `group-${index}/entry-${index}.ts`, "export {};");
    }

    let activeReads = 0;
    let peakReads = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      const target = args[0];
      if (typeof target === "string" && target.startsWith(cwd)) {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 4));
        try {
          return await originalReaddir(...args);
        } finally {
          activeReads -= 1;
        }
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);

    await searchWorkspaceEntries({ cwd, query: "", limit: 200 });

    assert.isAtMost(peakReads, 32);
  });
});

describe("resolveWorkspaceFileBySuffix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a unique bare basename to its tracked path", async () => {
    const cwd = makeTempDir("synara-suffix-unique-");
    writeFile(cwd, "apps/web/src/lib/kanbanDispatch.ts", "export {};");

    const resolution = await resolveWorkspaceFileBySuffix({
      cwd,
      relativePath: "kanbanDispatch.ts",
    });

    expect(resolution).toEqual({
      status: "resolved",
      relativePath: "apps/web/src/lib/kanbanDispatch.ts",
    });
  });

  it("resolves a unique partial path tail", async () => {
    const cwd = makeTempDir("synara-suffix-tail-");
    writeFile(cwd, "apps/web/src/lib/chatReferences.ts", "export {};");

    const resolution = await resolveWorkspaceFileBySuffix({
      cwd,
      relativePath: "lib/chatReferences.ts",
    });

    expect(resolution).toEqual({
      status: "resolved",
      relativePath: "apps/web/src/lib/chatReferences.ts",
    });
  });

  it("reports the competing matches for an ambiguous basename", async () => {
    const cwd = makeTempDir("synara-suffix-ambiguous-");
    writeFile(cwd, "apps/web/src/kanbanDispatch.ts", "export {};");
    writeFile(cwd, "apps/server/src/kanbanDispatch.ts", "export {};");

    const resolution = await resolveWorkspaceFileBySuffix({
      cwd,
      relativePath: "kanbanDispatch.ts",
    });

    expect(resolution).toEqual({
      status: "ambiguous",
      matches: ["apps/server/src/kanbanDispatch.ts", "apps/web/src/kanbanDispatch.ts"],
    });
  });

  it("returns unresolved when nothing matches", async () => {
    const cwd = makeTempDir("synara-suffix-missing-");
    writeFile(cwd, "apps/web/src/lib/kanbanDispatch.ts", "export {};");

    const resolution = await resolveWorkspaceFileBySuffix({
      cwd,
      relativePath: "does-not-exist.ts",
    });

    expect(resolution).toEqual({ status: "unresolved" });
  });

  it("ignores duplicate copies inside linked git worktrees", async () => {
    const cwd = makeTempDir("synara-suffix-worktree-");
    writeFile(cwd, "apps/web/src/lib/kanbanDispatch.ts", "export const real = 1;");
    writeFile(cwd, ".codex-worktrees/pr1/.git", "gitdir: /elsewhere/.git/worktrees/pr1\n");
    writeFile(
      cwd,
      ".codex-worktrees/pr1/apps/web/src/lib/kanbanDispatch.ts",
      "export const copy = 1;",
    );

    const resolution = await resolveWorkspaceFileBySuffix({
      cwd,
      relativePath: "kanbanDispatch.ts",
    });

    expect(resolution).toEqual({
      status: "resolved",
      relativePath: "apps/web/src/lib/kanbanDispatch.ts",
    });
  });

  it("does not prune git submodules (only linked worktrees)", async () => {
    const cwd = makeTempDir("synara-suffix-submodule-");
    // A submodule stores `.git` as a regular file too, but its pointer targets
    // `.git/modules/<name>`, not `.git/worktrees/<name>`. Its files are a
    // distinct repository that must remain discoverable — never pruned.
    writeFile(cwd, "vendor/lib/.git", "gitdir: /super/.git/modules/lib\n");
    writeFile(cwd, "vendor/lib/submoduleOnly.ts", "export const sub = 1;");

    const resolution = await resolveWorkspaceFileBySuffix({
      cwd,
      relativePath: "submoduleOnly.ts",
    });

    expect(resolution).toEqual({
      status: "resolved",
      relativePath: "vendor/lib/submoduleOnly.ts",
    });

    // The submodule's files must also appear in the index used for search.
    const search = await searchWorkspaceEntries({ cwd, query: "submoduleOnly", limit: 100 });
    assert.include(
      search.entries.map((entry) => entry.path),
      "vendor/lib/submoduleOnly.ts",
    );
  });

  it("re-scans disk for matches when the index is truncated", async () => {
    const cwd = makeTempDir("synara-suffix-truncated-");
    // Two real, distinct files share a basename on disk.
    writeFile(cwd, "apps/web/src/kanbanDispatch.ts", "export {};");
    writeFile(cwd, "apps/server/src/kanbanDispatch.ts", "export {};");

    // Force a truncated git index that lists only one of the two copies, so a
    // lookup against the index alone would wrongly look unique.
    const runProcessSpy = vi.spyOn(ProcessRunner, "runProcess");
    runProcessSpy.mockImplementation(async (command, args) => {
      if (command !== "git") {
        throw new Error(`Unexpected command: ${command}`);
      }
      if (args.includes("rev-parse")) {
        return {
          stdout: "true\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      if (args.includes("ls-files")) {
        return {
          stdout: "apps/web/src/kanbanDispatch.ts\0",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          stdoutTruncated: true,
          stderrTruncated: false,
        };
      }
      if (args.includes("check-ignore")) {
        return {
          stdout: "",
          stderr: "",
          code: 1,
          signal: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const resolution = await resolveWorkspaceFileBySuffix({
      cwd,
      relativePath: "kanbanDispatch.ts",
    });

    // The disk re-scan finds both real files, so the honest answer is ambiguous
    // rather than the false "unique" the truncated index would suggest.
    expect(resolution).toEqual({
      status: "ambiguous",
      matches: ["apps/server/src/kanbanDispatch.ts", "apps/web/src/kanbanDispatch.ts"],
    });
  });
});

describe("findWorkspaceFilesBySuffixOnDisk", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports complete when the whole tree is scanned", async () => {
    const cwd = makeTempDir("synara-scan-complete-");
    writeFile(cwd, "dup.ts", "export {};");
    writeFile(cwd, "nested/dup.ts", "export {};");

    const scan = await findWorkspaceFilesBySuffixOnDisk(cwd, "dup.ts");

    expect(scan.complete).toBe(true);
    expect(scan.matches.toSorted()).toEqual(["dup.ts", "nested/dup.ts"]);
  });

  it("reports incomplete when it stops at the scanned-directory cap", async () => {
    const cwd = makeTempDir("synara-scan-incomplete-");
    // A match sits at the root and a second, distinct match is one directory
    // deeper. Capping the scan at a single directory forces it to stop after
    // seeing only the first match — the exact false-unique hazard.
    writeFile(cwd, "dup.ts", "export {};");
    writeFile(cwd, "nested/dup.ts", "export {};");

    const scan = await findWorkspaceFilesBySuffixOnDisk(cwd, "dup.ts", {
      maxMatches: 64,
      maxDirectories: 1,
    });

    expect(scan.complete).toBe(false);
    expect(scan.matches).toEqual(["dup.ts"]);
    // A single match from an incomplete scan must NOT be reported as resolved.
    expect(classifySuffixMatches(scan.matches, scan.complete)).toEqual({ status: "indeterminate" });
  });
});

describe("classifySuffixMatches", () => {
  it("resolves a single match only when the scan was complete", () => {
    expect(classifySuffixMatches(["a/x.ts"], true)).toEqual({
      status: "resolved",
      relativePath: "a/x.ts",
    });
    // Fail closed: an incomplete scan cannot prove the single match is unique.
    expect(classifySuffixMatches(["a/x.ts"], false)).toEqual({ status: "indeterminate" });
  });

  it("treats two or more distinct matches as ambiguous even when incomplete", () => {
    expect(classifySuffixMatches(["b/x.ts", "a/x.ts"], false)).toEqual({
      status: "ambiguous",
      matches: ["a/x.ts", "b/x.ts"],
    });
  });

  it("distinguishes a complete empty scan from an incomplete one", () => {
    expect(classifySuffixMatches([], true)).toEqual({ status: "unresolved" });
    expect(classifySuffixMatches([], false)).toEqual({ status: "indeterminate" });
  });
});

describe("listWorkspaceDirectories", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can include files after directories for local recursive browsing", async () => {
    const cwd = makeTempDir("synara-workspace-list-directories-");
    writeFile(cwd, "docs/guide.md", "# guide");
    writeFile(cwd, "docs/api/reference.txt", "api");
    writeFile(cwd, "README.md", "root");

    const result = await listWorkspaceDirectories({ cwd, includeFiles: true });

    expect(result.entries).toEqual([
      { path: "docs", name: "docs", kind: "directory", hasChildren: true },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
  });

  it("rejects relative paths that escape the workspace root", async () => {
    const cwd = makeTempDir("synara-workspace-list-directories-");
    writeFile(cwd, "docs/guide.md", "# guide");

    for (const relativePath of ["..", "../..", "docs/../../etc", "/etc"]) {
      await expect(
        listWorkspaceDirectories({ cwd, includeFiles: true, relativePath }),
      ).rejects.toThrow("outside the workspace root");
    }

    // Traversal that stays contained inside the root is still allowed.
    const contained = await listWorkspaceDirectories({
      cwd,
      includeFiles: true,
      relativePath: "docs/../docs",
    });
    expect(contained.entries.map((entry) => entry.name)).toEqual(["guide.md"]);
  });

  it("rejects symlinked directories that escape the workspace root", async () => {
    const cwd = makeTempDir("synara-workspace-list-directories-");
    const outside = makeTempDir("synara-workspace-list-outside-");
    writeFile(outside, "secret.txt", "top secret");
    fs.symlinkSync(outside, path.join(cwd, "innocent"));

    await expect(
      listWorkspaceDirectories({ cwd, includeFiles: true, relativePath: "innocent" }),
    ).rejects.toThrow("outside the workspace root");

    // A symlink that resolves inside the root is still allowed.
    writeFile(cwd, "docs/guide.md", "# guide");
    fs.symlinkSync(path.join(cwd, "docs"), path.join(cwd, "docs-alias"));
    const contained = await listWorkspaceDirectories({
      cwd,
      includeFiles: true,
      relativePath: "docs-alias",
    });
    expect(contained.entries.map((entry) => entry.name)).toEqual(["guide.md"]);
  });
});

describe("discoverProjectScripts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers root package scripts with lockfile-selected commands", async () => {
    const cwd = makeTempDir("synara-script-discovery-root-");
    writeFile(
      cwd,
      "package.json",
      JSON.stringify({ name: "root-app", scripts: { dev: "vite", start: "vite --host" } }),
    );
    writeFile(cwd, "bun.lock", "");

    const result = await discoverProjectScripts({ cwd });

    expect(result.targets).toEqual([
      {
        cwd,
        relativePath: "",
        packageJsonPath: path.join(cwd, "package.json"),
        packageName: "root-app",
        scripts: [
          { name: "dev", command: "bun run dev" },
          { name: "start", command: "bun run start" },
        ],
      },
    ]);
  });

  it("discovers shallow nested package scripts", async () => {
    const cwd = makeTempDir("synara-script-discovery-nested-");
    writeFile(cwd, "apps/web/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/web/pnpm-lock.yaml", "");

    const result = await discoverProjectScripts({ cwd, depth: 2 });

    expect(result.targets).toEqual([
      {
        cwd: path.join(cwd, "apps/web"),
        relativePath: "apps/web",
        packageJsonPath: path.join(cwd, "apps/web/package.json"),
        scripts: [{ name: "dev", command: "pnpm run dev" }],
      },
    ]);
  });

  it("ignores invalid package json files", async () => {
    const cwd = makeTempDir("synara-script-discovery-invalid-");
    writeFile(cwd, "package.json", "{ nope");
    writeFile(cwd, "apps/ok/package.json", JSON.stringify({ scripts: { start: "vite" } }));

    const result = await discoverProjectScripts({ cwd, depth: 2 });

    expect(result.targets.map((target) => target.relativePath)).toEqual(["apps/ok"]);
  });

  it("skips ignored package directories", async () => {
    const cwd = makeTempDir("synara-script-discovery-ignored-");
    writeFile(cwd, "node_modules/pkg/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "dist/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "packages/app/package.json", JSON.stringify({ scripts: { dev: "vite" } }));

    const result = await discoverProjectScripts({ cwd, depth: 2 });

    expect(result.targets.map((target) => target.relativePath)).toEqual(["packages/app"]);
  });

  it("prefers package manager lockfiles in discovery order", async () => {
    const cwd = makeTempDir("synara-script-discovery-package-manager-");
    writeFile(cwd, "apps/bun/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/bun/bun.lockb", "");
    writeFile(cwd, "apps/pnpm/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/pnpm/pnpm-lock.yaml", "");
    writeFile(cwd, "apps/yarn/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    writeFile(cwd, "apps/yarn/yarn.lock", "");
    writeFile(cwd, "apps/npm/package.json", JSON.stringify({ scripts: { dev: "vite" } }));

    const result = await discoverProjectScripts({ cwd, depth: 2 });
    const commandsByPath = new Map(
      result.targets.map((target) => [target.relativePath, target.scripts[0]?.command]),
    );

    expect(commandsByPath.get("apps/bun")).toBe("bun run dev");
    expect(commandsByPath.get("apps/pnpm")).toBe("pnpm run dev");
    expect(commandsByPath.get("apps/yarn")).toBe("yarn dev");
    expect(commandsByPath.get("apps/npm")).toBe("npm run dev");
  });
});
