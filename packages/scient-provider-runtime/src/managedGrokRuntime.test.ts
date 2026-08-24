// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedGrokArtifact } from "./grokManifest.ts";
import { ManagedGrokRuntime } from "./managedGrokRuntime.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("ManagedGrokRuntime conformance", () => {
  it("keeps Grok in its own provider-private runtime root", () => {
    const artifact = resolveReviewedGrokArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();

    const launchPath = new ManagedGrokRuntime("/scient-data").launchPath(artifact!);

    expect(launchPath.replaceAll("\\", "/")).toMatch(
      /\/provider-runtimes\/grok\/versions\/1\.0\.5\/darwin-arm64\/grok$/u,
    );
  });

  it("passes the reviewed xAI artifact through shared verification and activation", async () => {
    const artifact = resolveReviewedGrokArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-grok-runtime-"));
    temporaryRoots.push(root);
    const events: string[] = [];
    const runtime = new ManagedGrokRuntime(root, {
      download: async ({ destination, url }) => {
        expect(url).toBe(artifact!.url);
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, "reviewed-grok", { flag: "wx" });
        events.push("download");
      },
      verify: async (filePath, checksum) => {
        expect(await NodeFSP.readFile(filePath, "utf8")).toBe("reviewed-grok");
        expect(checksum).toEqual(artifact!.checksum);
        events.push("verify");
      },
      materialize: async ({ destination, executablePath, platform }) => {
        expect(executablePath).toBe("grok");
        expect(platform).toBe("darwin");
        await NodeFSP.mkdir(destination, { recursive: true });
        const executable = NodePath.join(destination, executablePath);
        await NodeFSP.writeFile(executable, "grok-executable", { mode: 0o755 });
        events.push("materialize");
        return executable;
      },
      smoke: async (executable, args, displayName) => {
        expect(await NodeFSP.readFile(executable, "utf8")).toBe("grok-executable");
        expect(args).toEqual(["--version"]);
        expect(displayName).toBe("Grok");
        events.push("smoke");
      },
    });

    const installed = await runtime.install({
      artifact: artifact!,
      signal: new AbortController().signal,
    });

    expect(installed).toMatchObject({ installed: true, activeVersion: "1.0.5" });
    expect(events).toEqual(["download", "verify", "materialize", "smoke"]);
  });
});
