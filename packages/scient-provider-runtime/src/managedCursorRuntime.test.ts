// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedCursorArtifact } from "./cursorManifest.ts";
import { ManagedCursorRuntime } from "./managedCursorRuntime.ts";
import type { ManagedRuntimeChecksum } from "./managedRuntimeArtifact.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("ManagedCursorRuntime", () => {
  it("retains active and previous replacement receipts across restart and failed replacement", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cursor-lineage-"));
    temporaryRoots.push(root);
    const policy = resolveReviewedCursorArtifact({ platform: "darwin", arch: "arm64" })!;
    const a = policy.version;
    const b = `${a.split("-")[0]}-1111111`;
    const artifact = {
      ...policy,
      version: b,
      supersedes: [a],
      url: policy.url.replace(a, b),
      catalogRevision: "qualified-cursor-replacement",
    };
    const dependencies = {
      download: async ({ destination }: { destination: string }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, "archive");
      },
      verify: async () => {},
      materialize: async ({
        destination,
        executablePath,
      }: {
        destination: string;
        executablePath: string;
      }) => {
        const executable = NodePath.join(destination, executablePath);
        await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
        await NodeFSP.writeFile(executable, "native fixture", { mode: 0o755 });
        return executable;
      },
      smoke: async () => {},
    };
    const runtime = new ManagedCursorRuntime(root, dependencies);
    const signal = new AbortController().signal;
    await runtime.install({ artifact: policy, signal });
    await runtime.install({ artifact, signal });
    const reopened = new ManagedCursorRuntime(root, dependencies);
    const state = await reopened.status(artifact);
    expect(state.activeArtifact?.supersedes).toEqual([a]);
    expect(state.previousArtifact?.version).toBe(a);
    const broken = new ManagedCursorRuntime(root, {
      ...dependencies,
      smoke: async () => {
        throw new Error("native identity mismatch");
      },
    });
    await expect(
      broken.install({
        artifact: { ...artifact, version: `${a.split("-")[0]}-2222222`, supersedes: [a, b] },
        signal,
      }),
    ).rejects.toThrow("native identity mismatch");
    expect((await reopened.status(artifact)).activeArtifact?.supersedes).toEqual([a]);
    expect((await reopened.status(artifact)).previousArtifact?.version).toBe(a);
  });

  it("keeps Cursor in its own provider-private runtime root", () => {
    const artifact = resolveReviewedCursorArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();

    const launchPath = new ManagedCursorRuntime("/scient-data").launchPath(artifact!);

    expect(launchPath.replaceAll("\\", "/")).toMatch(
      /\/provider-runtimes\/cursor\/versions\/2026\.08\.11-e8db854\/darwin-arm64\/dist-package\/cursor-agent$/u,
    );
  });

  it("passes reviewed extraction and smoke metadata through atomic activation", async () => {
    const artifact = resolveReviewedCursorArtifact({ platform: "win32", arch: "x64" });
    expect(artifact).toBeDefined();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cursor-runtime-"));
    temporaryRoots.push(root);
    const events: string[] = [];
    const runtime = new ManagedCursorRuntime(root, {
      download: async ({ destination }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, "reviewed-archive", { flag: "wx" });
      },
      verify: async (_filePath: string, checksum: ManagedRuntimeChecksum) => {
        expect(checksum).toEqual(artifact!.checksum);
        events.push("verify");
      },
      materialize: async ({ destination, executablePath, extractionLimits }) => {
        expect(extractionLimits).toEqual(artifact!.extractionLimits);
        const packageDirectory = NodePath.join(destination, "dist-package");
        await NodeFSP.mkdir(packageDirectory, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(packageDirectory, "node.exe"), "node");
        await NodeFSP.writeFile(NodePath.join(packageDirectory, "index.js"), "index");
        const executable = NodePath.join(destination, executablePath);
        await NodeFSP.writeFile(executable, "launcher");
        events.push("materialize");
        return executable;
      },
      smoke: async (executable, args, _displayName, _environment, options) => {
        expect(executable.replaceAll("\\", "/")).toMatch(/\/dist-package\/node\.exe$/u);
        expect(args).toEqual(["index.js", "--disable-auto-update", "--version"]);
        expect(options?.cwd?.replaceAll("\\", "/")).toMatch(/\/dist-package$/u);
        expect(options?.expectedVersion).toBe(artifact!.version);
        events.push("smoke");
      },
    });

    const installed = await runtime.install({
      artifact: artifact!,
      signal: new AbortController().signal,
    });

    expect(installed).toMatchObject({ installed: true, activeVersion: artifact!.version });
    expect(events).toEqual(["verify", "materialize", "smoke"]);
  });
});
