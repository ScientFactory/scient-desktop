// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedDroidArtifact } from "./droidManifest.ts";
import { ManagedDroidRuntime } from "./managedDroidRuntime.ts";
import type { ManagedRuntimeChecksum } from "./managedRuntimeArtifact.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("ManagedDroidRuntime", () => {
  it("keeps Droid in its own provider-private runtime root", () => {
    const artifact = resolveReviewedDroidArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();

    const launchPath = new ManagedDroidRuntime("/scient-data").launchPath(artifact!);

    expect(launchPath.replaceAll("\\", "/")).toMatch(
      /\/provider-runtimes\/droid\/versions\/0\.203\.0\/darwin-arm64\/droid$/u,
    );
  });

  it("verifies, activates, reloads, repairs, and removes the reviewed raw binary", async () => {
    const artifact = resolveReviewedDroidArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-droid-runtime-"));
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
        await NodeFSP.writeFile(destination, "reviewed-droid", { flag: "wx" });
      },
      verify: async (filePath: string, checksum: ManagedRuntimeChecksum) => {
        expect(await NodeFSP.readFile(filePath, "utf8")).toBe("reviewed-droid");
        expect(checksum).toEqual(artifact!.checksum);
        events.push(`verify:${checksum.algorithm}`);
      },
      materialize: async ({
        destination,
        executablePath,
      }: {
        destination: string;
        executablePath: string;
      }) => {
        await NodeFSP.mkdir(destination, { recursive: true });
        const executable = NodePath.join(destination, executablePath);
        await NodeFSP.writeFile(executable, "droid-executable", { mode: 0o755 });
        events.push(`materialize:${executablePath}`);
        return executable;
      },
      smoke: async (
        executable: string,
        _args: ReadonlyArray<string>,
        _displayName: string,
        environment?: Readonly<Record<string, string>>,
      ) => {
        expect(await NodeFSP.readFile(executable, "utf8")).toBe("droid-executable");
        expect(environment).toEqual({ FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" });
        events.push(`smoke:${NodePath.basename(executable)}`);
      },
    };
    const runtime = new ManagedDroidRuntime(root, dependencies);

    const installed = await runtime.install({
      artifact: artifact!,
      signal: new AbortController().signal,
    });
    expect(installed).toMatchObject({ installed: true, activeVersion: "0.203.0" });
    expect(events).toEqual([
      `download:${artifact!.url}`,
      "verify:sha256",
      "materialize:droid",
      "smoke:droid",
    ]);

    const afterRestart = await new ManagedDroidRuntime(root, dependencies).status(artifact!);
    expect(afterRestart).toEqual(installed);

    await runtime.install({ artifact: artifact!, signal: new AbortController().signal });
    expect(events.filter((event) => event === "verify:sha256")).toHaveLength(2);
    expect(events.filter((event) => event === "smoke:droid")).toHaveLength(2);

    await runtime.remove();
    await runtime.remove();
    expect((await runtime.status(artifact!)).installed).toBe(false);
    expect(await runtime.readState()).toBeUndefined();
  });

  it("never activates a binary when SHA-256 verification fails", async () => {
    const artifact = resolveReviewedDroidArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-droid-runtime-"));
    temporaryRoots.push(root);
    const runtime = new ManagedDroidRuntime(root, {
      download: async ({ destination }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, "tampered", { flag: "wx" });
      },
      verify: async () => {
        throw new Error("SHA-256 mismatch");
      },
    });

    await expect(
      runtime.install({ artifact: artifact!, signal: new AbortController().signal }),
    ).rejects.toThrow("SHA-256 mismatch");
    expect((await runtime.status(artifact!)).installed).toBe(false);
    expect(await runtime.readState()).toBeUndefined();
  });
});
