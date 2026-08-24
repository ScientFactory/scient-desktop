// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedCodexArtifact } from "./codexManifest.ts";
import { ManagedCodexRuntime } from "./managedCodexRuntime.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("ManagedCodexRuntime conformance", () => {
  it("keeps Codex in its own provider-private runtime root", () => {
    const artifact = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();

    const launchPath = new ManagedCodexRuntime("/scient-data").launchPath(artifact!);

    expect(launchPath.replaceAll("\\", "/")).toMatch(
      /\/provider-runtimes\/codex\/versions\/0\.149\.1\/darwin-arm64\/bin\/codex$/u,
    );
  });

  it("requires the complete reviewed Codex package before activating it", async () => {
    const artifact = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-codex-runtime-"));
    temporaryRoots.push(root);
    const events: string[] = [];
    const runtime = new ManagedCodexRuntime(root, {
      download: async ({ destination }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, "reviewed-package", { flag: "wx" });
      },
      verify: async (_filePath, checksum) => {
        expect(checksum).toEqual(artifact!.checksum);
        events.push("verify");
      },
      materialize: async ({ destination, executablePath, auxiliaryExecutablePaths, platform }) => {
        expect(executablePath).toBe(artifact!.executablePath);
        expect(auxiliaryExecutablePaths).toEqual(artifact!.auxiliaryExecutablePaths);
        expect(platform).toBe("darwin");
        const reviewedExecutables = [executablePath, ...(auxiliaryExecutablePaths ?? [])];
        for (const reviewedPath of reviewedExecutables) {
          const filePath = NodePath.join(destination, reviewedPath);
          await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
          await NodeFSP.writeFile(filePath, reviewedPath, { mode: 0o755 });
        }
        events.push("materialize");
        return NodePath.join(destination, executablePath);
      },
      smoke: async (executable, args, displayName) => {
        expect(executable.replaceAll("\\", "/")).toMatch(/\/bin\/codex$/u);
        expect(args).toEqual(["--version"]);
        expect(displayName).toBe("Codex");
        events.push("smoke");
      },
    });

    const installed = await runtime.install({
      artifact: artifact!,
      signal: new AbortController().signal,
    });

    expect(installed).toMatchObject({ installed: true, activeVersion: artifact!.version });
    expect(events).toEqual(["verify", "materialize", "smoke"]);
    for (const reviewedPath of [
      artifact!.executablePath,
      ...(artifact!.auxiliaryExecutablePaths ?? []),
    ]) {
      expect(
        await NodeFSP.readFile(
          NodePath.join(NodePath.dirname(NodePath.dirname(installed.launchPath)), reviewedPath),
          "utf8",
        ),
      ).toBe(reviewedPath);
    }
  });
});
