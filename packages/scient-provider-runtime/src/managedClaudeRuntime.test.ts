// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedClaudeArtifact } from "./claudeManifest.ts";
import { ManagedClaudeRuntime } from "./managedClaudeRuntime.ts";
import type { ManagedRuntimeChecksum } from "./managedRuntimeArtifact.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("ManagedClaudeRuntime", () => {
  it("keeps Claude in its own provider-private runtime root", () => {
    const artifact = resolveReviewedClaudeArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();
    const launchPath = new ManagedClaudeRuntime("/scient-data").launchPath(artifact!);

    expect(launchPath.replaceAll("\\", "/")).toMatch(
      /\/provider-runtimes\/claude\/versions\/2\.1\.245\/darwin-arm64\/claude$/u,
    );
  });

  it.each(["x64", "arm64"] as const)(
    "runs the reviewed Windows %s artifact through download, checksum verification, smoke test, activation, restart, repair, and removal",
    async (arch) => {
      const artifact = resolveReviewedClaudeArtifact({ platform: "win32", arch });
      expect(artifact).toBeDefined();
      expect(artifact?.url).toMatch(new RegExp(`/win32-${arch}/claude\\.exe$`, "u"));

      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-claude-windows-"));
      temporaryRoots.push(root);
      const events: string[] = [];
      const dependencies = {
        now: (() => {
          let value = 1;
          return () => value++;
        })(),
        download: async ({ destination, url }: { destination: string; url: string }) => {
          events.push(`download:${url}`);
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.writeFile(destination, "reviewed-asset", { flag: "wx" });
        },
        verify: async (filePath: string, expectedChecksum: ManagedRuntimeChecksum) => {
          expect(NodePath.basename(filePath)).toBe(artifact!.artifactName);
          expect(await NodeFSP.readFile(filePath, "utf8")).toBe("reviewed-asset");
          expect(expectedChecksum).toEqual(artifact!.checksum);
          events.push("verify");
        },
        materialize: async ({
          destination,
          executablePath,
          platform,
        }: {
          destination: string;
          executablePath: string;
          platform: NodeJS.Platform;
        }) => {
          events.push(`materialize:${platform}:${executablePath}`);
          await NodeFSP.mkdir(destination, { recursive: true });
          const executable = NodePath.join(destination, executablePath);
          await NodeFSP.writeFile(executable, "windows-executable");
          return executable;
        },
        smoke: async (executable: string) => {
          events.push(`smoke:${NodePath.basename(executable)}`);
        },
      };
      const runtime = new ManagedClaudeRuntime(root, dependencies);

      const installed = await runtime.install({
        artifact: artifact!,
        signal: new AbortController().signal,
      });
      expect(installed.installed).toBe(true);
      expect(installed.launchPath).toMatch(/\/win32-(?:x64|arm64)\/claude\.exe$/u);
      expect(events).toEqual([
        `download:${artifact!.url}`,
        "verify",
        "materialize:win32:claude.exe",
        "smoke:claude.exe",
      ]);
      expect(await runtime.readState()).toMatchObject({
        schemaVersion: 3,
        selection: "managed",
        targetKey: `win32-${arch}`,
        activeVersion: artifact!.version,
        executableRelativePath: expect.stringMatching(/claude\.exe$/u),
      });

      const afterRestart = await new ManagedClaudeRuntime(root, dependencies).status(artifact!);
      expect(afterRestart).toEqual(installed);

      await runtime.install({ artifact: artifact!, signal: new AbortController().signal });
      expect(events.filter((event) => event === "verify")).toHaveLength(2);
      expect(events.filter((event) => event === "smoke:claude.exe")).toHaveLength(2);

      await runtime.remove();
      expect((await runtime.status(artifact!)).installed).toBe(false);
      expect(await runtime.readState()).toBeUndefined();
    },
  );

  it("never activates a Windows artifact when checksum verification fails", async () => {
    const artifact = resolveReviewedClaudeArtifact({ platform: "win32", arch: "x64" });
    expect(artifact).toBeDefined();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-claude-windows-"));
    temporaryRoots.push(root);
    const runtime = new ManagedClaudeRuntime(root, {
      download: async ({ destination }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, "wrong-asset", { flag: "wx" });
      },
      verify: async () => {
        throw new Error("checksum mismatch");
      },
    });

    await expect(
      runtime.install({ artifact: artifact!, signal: new AbortController().signal }),
    ).rejects.toThrow("checksum mismatch");
    expect((await runtime.status(artifact!)).installed).toBe(false);
  });
});
