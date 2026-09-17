// @effect-diagnostics nodeBuiltinImport:off -- synthetic private package fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "vite-plus/test";
import { isolateManagedPythonPackages } from "./ManagedPythonPackageIsolation.ts";

it("detaches hardlink fallback without following symlinks or changing executable modes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-isolation-"));
  try {
    const cache = NodePath.join(root, "cache");
    const env = NodePath.join(root, "environment");
    await NodeFSP.mkdir(env);
    await NodeFSP.writeFile(cache, "original", { mode: 0o700 });
    await NodeFSP.link(cache, NodePath.join(env, "package"));
    await NodeFSP.symlink(cache, NodePath.join(env, "python"));
    await isolateManagedPythonPackages(env, new AbortController().signal);
    expect((await NodeFSP.stat(NodePath.join(env, "package"))).nlink).toBe(1);
    expect((await NodeFSP.stat(NodePath.join(env, "package"))).mode & 0o777).toBe(0o700);
    await NodeFSP.writeFile(NodePath.join(env, "package"), "changed");
    expect(await NodeFSP.readFile(cache, "utf8")).toBe("original");
    expect((await NodeFSP.lstat(NodePath.join(env, "python"))).isSymbolicLink()).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(isolateManagedPythonPackages(env, aborted.signal)).rejects.toBeDefined();
    expect(await NodeFSP.readdir(env)).toEqual(["package", "python"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
