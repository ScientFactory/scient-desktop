import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { formatMarkdown, measureForkFootprint } from "./scient-fork-footprint.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-footprint-test-"));
  directories.push(cwd);
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path, content) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  };
  const remove = (path) => NodeFS.rmSync(NodePath.join(cwd, path));
  git("init", "--initial-branch=main");
  git("config", "user.name", "Footprint test");
  git("config", "user.email", "footprint-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", NodePath.join(cwd, "no-hooks"));
  const commit = () => {
    git("add", "--all");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const pin = (sha) => write("upstream-state.json", JSON.stringify({ integrationBase: sha }));
  write("host.ts", "export const host = 1;\n");
  write("shared.ts", "export const shared = 1;\n");
  write("legacy.ts", "export const legacy = 1;\n");
  write("logo.bin", Buffer.from([0, 1, 2, 3]));
  write(".repos/reference/code.ts", "export const reference = 1;\n");
  const t3 = commit();
  pin(t3);
  write("shared.ts", "export const shared = 2;\nexport const scient = true;\n");
  write("logo.bin", Buffer.from([0, 9, 9, 9]));
  write(".repos/reference/code.ts", "export const reference = 2;\n");
  write("scient/feature.ts", "export const feature = true;\n");
  const base = commit();
  const footprint = (head, from = base) =>
    measureForkFootprint(["--base", from, "--head", head], { cwd });
  return { git, write, remove, commit, pin, t3, base, footprint };
}

describe("Scient fork footprint", () => {
  it("counts divergence only in files T3 also has", async () => {
    const f = fixture();
    const result = await f.footprint(f.base);
    expect(result.base).toMatchObject({
      baseline: f.t3,
      changedFiles: 2,
      addedLines: 2,
      removedLines: 1,
      deletedFiles: 0,
    });
  });

  it("lists T3 files a change newly diverges and those it returns to identical", async () => {
    const f = fixture();
    f.write("host.ts", "export const host = 2;\n");
    f.write("shared.ts", "export const shared = 1;\n");
    f.write("scient/other.ts", "export const other = true;\n");
    const result = await f.footprint(f.commit());
    expect(result.delta).toEqual({
      changedFiles: 0,
      addedLines: -1,
      removedLines: 0,
      deletedFiles: 0,
    });
    expect(result.newlyDiverged).toEqual(["host.ts"]);
    expect(result.returnedToIdentical).toEqual(["shared.ts"]);
    expect(formatMarkdown(result)).toContain("**Newly diverged from T3 (1)**\n\n- `host.ts`");
  });

  it("counts deleted T3 files apart from changed ones", async () => {
    const f = fixture();
    f.remove("legacy.ts");
    f.remove("shared.ts");
    const result = await f.footprint(f.commit());
    expect(result.head).toMatchObject({ changedFiles: 1, deletedFiles: 2 });
    expect(result.newlyDeleted).toEqual(["legacy.ts", "shared.ts"]);
    expect(result.newlyDiverged).toEqual([]);
  });

  it("measures each side against its own baseline when an alignment moves it", async () => {
    const f = fixture();
    f.git("checkout", "--quiet", "-b", "t3", f.t3);
    f.write("host.ts", "export const host = 3;\n");
    f.write("shared.ts", "export const shared = 2;\nexport const scient = true;\n");
    const next = f.commit();
    f.git("checkout", "--quiet", "main");
    f.git("merge", "--no-ff", "--no-commit", "--strategy-option=ours", next);
    f.pin(next);
    const result = await f.footprint(f.commit());
    expect(result.baselineMoved).toEqual({ from: f.t3, to: next, t3Commits: 1 });
    expect(result.head).toMatchObject({ baseline: next, changedFiles: 1 });
    expect(result.delta.changedFiles).toBe(-1);
    expect(result.newlyDiverged).toBeUndefined();
  });

  it("reports a baseline missing from the clone instead of failing", async () => {
    const f = fixture();
    f.pin("0123456789abcdef0123456789abcdef01234567");
    const result = await f.footprint(f.commit());
    expect(result.status).toBe("unavailable");
    expect(formatMarkdown(result)).toContain("Not measured: T3 integrationBase 0123456789");
  });
});
