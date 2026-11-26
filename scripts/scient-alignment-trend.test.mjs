import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { alignmentTrend } from "./scient-alignment-trend.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-trend-test-"));
  directories.push(cwd);
  const git = (...args) =>
    NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
  const write = (path, content) => NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  const commit = (files) => {
    for (const [path, content] of Object.entries(files)) write(path, content);
    git("add", "--all");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Trend test");
  git("config", "user.email", "trend-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", NodePath.join(cwd, "no-hooks"));
  commit({ "a.ts": "a0\n", "b.ts": "b0\n" });
  git("branch", "upstream");
  const align = (files) => {
    git("checkout", "-q", "upstream");
    const target = commit(files);
    git("checkout", "-q", "main");
    git("merge", "--no-ff", "-q", "-s", "ours", "-m", "align", target);
    return target;
  };
  const trend = (args = []) =>
    alignmentTrend(["--ref", "main", "--upstream", "upstream", ...args], { cwd });
  return { git, commit, align, trend };
}

describe("alignment conflict trend", () => {
  it("counts first-seen conflicts of an alignment merge", () => {
    const f = fixture();
    f.commit({ "a.ts": "owned\n" });
    const target = f.align({ "a.ts": "official\n", "c.ts": "new\n" });

    const [alignment] = f.trend().alignments;
    expect(alignment).toMatchObject({
      target,
      officialCommits: 1,
      incomingPaths: 2,
      overlaps: 1,
      conflicted: ["a.ts"],
      conflictsPer100: 50,
    });
  });

  it("excludes catch-up merges whose second parent is owned", () => {
    const f = fixture();
    f.git("checkout", "-q", "-b", "side");
    const owned = f.commit({ "b.ts": "side\n" });
    f.git("checkout", "-q", "main");
    f.git("merge", "--no-ff", "-q", "-m", "catch up", owned);

    expect(f.trend().alignments).toEqual([]);
  });

  it("reports paths that conflict across alignments", () => {
    const f = fixture();
    f.commit({ "a.ts": "owned 1\n" });
    f.align({ "a.ts": "official 1\n" });
    f.commit({ "a.ts": "owned 2\n" });
    f.align({ "a.ts": "official 2\n" });

    const result = f.trend(["--min-recurrence", "2"]);
    expect(result.alignments).toHaveLength(2);
    expect(result.recurring).toEqual([{ path: "a.ts", count: 2, area: "a.ts" }]);
  });
});
