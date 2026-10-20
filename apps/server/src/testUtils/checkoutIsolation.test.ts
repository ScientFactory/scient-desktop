// @effect-diagnostics nodeBuiltinImport:off - checks the Git environment the setup gives every test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const gitDir = (cwd: string) =>
  NodeChildProcess.spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });

it("keeps Git from finding the source checkout below its root", () => {
  for (const cwd of [process.cwd(), NodePath.join(process.cwd(), "src")]) {
    const result = gitDir(cwd);
    expect(result.status, cwd).not.toBe(0);
    expect(result.stderr).toContain("not a git repository");
  }
});

it("leaves repositories outside the checkout and the shared Git config untouched", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkout-isolation-"));
  try {
    expect(
      NodeChildProcess.spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8" })
        .status,
    ).toBe(0);
    const nested = NodePath.join(directory, "nested");
    NodeFS.mkdirSync(nested);
    expect(gitDir(nested).status).toBe(0);
    const autocrlf = NodeChildProcess.spawnSync("git", ["config", "core.autocrlf"], {
      cwd: nested,
      encoding: "utf8",
    });
    expect(autocrlf.stdout.trim()).toBe("false");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
