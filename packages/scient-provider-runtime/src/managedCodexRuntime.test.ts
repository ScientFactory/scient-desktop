// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ManagedRuntimeArtifact } from "./codexManifest.ts";
import { ManagedCodexRuntime } from "./managedCodexRuntime.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function artifact(version: string): ManagedRuntimeArtifact {
  return {
    provider: "codex",
    version,
    target: { platform: "darwin", arch: "arm64" },
    artifactName: "codex.tar.gz",
    url: "https://github.com/openai/codex/releases/download/test/codex.tar.gz",
    allowedHosts: ["github.com"],
    sha256: "0".repeat(64),
    size: 5,
    archiveFormat: "tar.gz",
    executablePath: "codex",
    smokeArgs: ["--version"],
    catalogRevision: `test:${version}`,
    supportTier: "fully_assisted",
    supportMessage: "Test target.",
  };
}

async function makeRuntime(input?: { readonly smokeFailsAtCall?: number }) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-provider-runtime-"));
  temporaryRoots.push(root);
  let now = 1;
  let smokeCalls = 0;
  const runtime = new ManagedCodexRuntime(root, {
    now: () => now++,
    download: async ({ destination }) => {
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.writeFile(destination, "asset", { flag: "wx" });
    },
    verify: async () => undefined,
    materialize: async ({ destination, executablePath }) => {
      await NodeFSP.mkdir(destination, { recursive: true });
      const executable = NodePath.join(destination, executablePath);
      await NodeFSP.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      return executable;
    },
    smoke: async () => {
      smokeCalls += 1;
      if (input?.smokeFailsAtCall === smokeCalls) {
        throw new Error("smoke failed");
      }
    },
  });
  return { root, runtime };
}

describe("ManagedCodexRuntime", () => {
  it("stages, verifies, smoke tests, and atomically records an installation", async () => {
    const { runtime } = await makeRuntime();
    const recipe = artifact("1.2.3");
    const stages: string[] = [];

    const status = await runtime.install({
      artifact: recipe,
      signal: new AbortController().signal,
      onProgress: ({ stage }) => stages.push(stage),
    });

    expect(status.installed).toBe(true);
    expect(status.activeVersion).toBe("1.2.3");
    expect(await NodeFSP.readFile(status.launchPath, "utf8")).toContain("exit 0");
    expect(stages).toEqual([
      "preparing",
      "downloading",
      "verifying",
      "installing",
      "testing",
      "activating",
    ]);
  });

  it("does not replace the working release when the staged smoke test fails", async () => {
    const { runtime } = await makeRuntime({ smokeFailsAtCall: 2 });
    const first = artifact("1.0.0");
    await runtime.install({ artifact: first, signal: new AbortController().signal });

    await expect(
      runtime.install({ artifact: artifact("2.0.0"), signal: new AbortController().signal }),
    ).rejects.toThrow("smoke failed");

    const state = await runtime.readState();
    expect(state?.activeVersion).toBe("1.0.0");
    expect((await runtime.status(first)).installed).toBe(true);
  });

  it("keeps launching the active release while a newer reviewed artifact is available", async () => {
    const { runtime } = await makeRuntime();
    const first = artifact("1.0.0");
    const installed = await runtime.install({
      artifact: first,
      signal: new AbortController().signal,
    });

    const status = await runtime.status(artifact("2.0.0"));

    expect(status.installed).toBe(true);
    expect(status.activeVersion).toBe("1.0.0");
    expect(status.launchPath).toBe(installed.launchPath);
  });

  it("does not launch a managed binary recorded for a different computer target", async () => {
    const { runtime } = await makeRuntime();
    await runtime.install({
      artifact: artifact("1.0.0"),
      signal: new AbortController().signal,
    });

    const status = await runtime.status({
      ...artifact("1.0.0"),
      target: { platform: "darwin", arch: "x64" },
    });

    expect(status.installed).toBe(false);
    expect(status.activeVersion).toBeNull();
  });

  it("cleans interrupted staging data and removes only its app-private root", async () => {
    const { root, runtime } = await makeRuntime();
    const staging = NodePath.join(root, "provider-runtimes", "codex", "staging", "abandoned");
    const unrelated = NodePath.join(root, "unrelated.txt");
    await NodeFSP.mkdir(staging, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(staging, "partial"), "partial");
    await NodeFSP.writeFile(unrelated, "keep");

    await runtime.reconcile();
    await expect(NodeFSP.access(staging)).rejects.toThrow();
    await runtime.remove();
    expect(await NodeFSP.readFile(unrelated, "utf8")).toBe("keep");
  });

  it("restores the previous runtime after interruption during atomic replacement", async () => {
    const { root, runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    const installed = await runtime.install({
      artifact: recipe,
      signal: new AbortController().signal,
    });
    const targetDirectory = NodePath.dirname(installed.launchPath);
    const replacement = `${targetDirectory}.replaced-99`;
    const interruptedState = NodePath.join(
      root,
      "provider-runtimes",
      "codex",
      "state.json.10.99.tmp",
    );
    await NodeFSP.rename(targetDirectory, replacement);
    await NodeFSP.writeFile(interruptedState, "partial");

    await runtime.reconcile(recipe);

    expect((await runtime.status(recipe)).installed).toBe(true);
    await expect(NodeFSP.access(replacement)).rejects.toThrow();
    await expect(NodeFSP.access(interruptedState)).rejects.toThrow();
  });
});
