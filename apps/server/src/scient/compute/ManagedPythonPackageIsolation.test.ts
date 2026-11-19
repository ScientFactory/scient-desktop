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
    expect(await NodeFSP.readdir(env)).toEqual(["package", "python"]);
    const aborted = new AbortController();
    aborted.abort();
    await expect(isolateManagedPythonPackages(env, aborted.signal)).rejects.toBeDefined();
    expect(await NodeFSP.readdir(env)).toEqual(["package", "python"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("detaches every nested hardlink and leaves linked directories outside alone", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-isolation-"));
  try {
    const cache = NodePath.join(root, "cache");
    const outside = NodePath.join(root, "outside");
    const env = NodePath.join(root, "environment");
    await NodeFSP.mkdir(cache);
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "kept"), "outside");
    await NodeFSP.link(NodePath.join(outside, "kept"), NodePath.join(root, "outside-link"));
    const packages = Array.from({ length: 100 }, (_, index) =>
      NodePath.join(env, "Lib", "site-packages", `package${index % 7}`, `module${index}.py`),
    );
    for (const [index, file] of packages.entries()) {
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(cache, `${index}`), `module ${index}`);
      await NodeFSP.link(NodePath.join(cache, `${index}`), file);
    }
    await NodeFSP.symlink(outside, NodePath.join(env, "linked"), "dir");
    await isolateManagedPythonPackages(env, new AbortController().signal);
    for (const [index, file] of packages.entries()) {
      expect((await NodeFSP.stat(file)).nlink).toBe(1);
      expect(await NodeFSP.readFile(file, "utf8")).toBe(`module ${index}`);
    }
    // The linked directory was not entered, so its file keeps its other link.
    expect((await NodeFSP.stat(NodePath.join(outside, "kept"))).nlink).toBe(2);
    expect(
      (await NodeFSP.readdir(env, { recursive: true })).some((name) => name.endsWith(".private")),
    ).toBe(false);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
