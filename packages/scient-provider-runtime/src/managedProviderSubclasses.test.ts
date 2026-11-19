// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedAntigravityArtifact } from "./antigravityManifest.ts";
import { resolveReviewedDroidArtifact } from "./droidManifest.ts";
import { resolveReviewedGrokArtifact } from "./grokManifest.ts";
import { ManagedAntigravityRuntime } from "./managedAntigravityRuntime.ts";
import { ManagedDroidRuntime } from "./managedDroidRuntime.ts";
import { ManagedGrokRuntime } from "./managedGrokRuntime.ts";
import type { ManagedRuntimeChecksum } from "./managedRuntimeArtifact.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

// The shared lifecycle is owned by managedProviderRuntime.test.ts. These rows check what each
// single-binary subclass adds: its runtime folder and its reviewed artifact's settings.
// regression: fd84026972 feat(provider): add managed Antigravity integration
// regression: 9f813b1745 test(provider-lifecycle): characterize existing behavior
const providers = [
  {
    name: "Droid",
    directory: "droid",
    makeRuntime: (
      root: string,
      dependencies?: ConstructorParameters<typeof ManagedDroidRuntime>[1],
    ) => new ManagedDroidRuntime(root, dependencies),
    resolve: resolveReviewedDroidArtifact,
    algorithm: "sha256",
    smokeEnvironment: { FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  },
  {
    name: "Antigravity",
    directory: "antigravity",
    makeRuntime: (
      root: string,
      dependencies?: ConstructorParameters<typeof ManagedAntigravityRuntime>[1],
    ) => new ManagedAntigravityRuntime(root, dependencies),
    resolve: resolveReviewedAntigravityArtifact,
    algorithm: "sha512",
    smokeEnvironment: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  },
  {
    name: "Grok",
    directory: "grok",
    makeRuntime: (
      root: string,
      dependencies?: ConstructorParameters<typeof ManagedGrokRuntime>[1],
    ) => new ManagedGrokRuntime(root, dependencies),
    resolve: resolveReviewedGrokArtifact,
    algorithm: "sha512",
    smokeEnvironment: undefined,
  },
] as const;

describe.each(providers)(
  "Managed$name Runtime",
  ({ name, directory, makeRuntime, resolve, algorithm, smokeEnvironment }) => {
    const reviewed = () => {
      const artifact = resolve({ platform: "darwin", arch: "arm64" });
      expect(artifact).toBeDefined();
      return artifact!;
    };
    const temporaryRoot = async () => {
      const root = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), `scient-${directory}-runtime-`),
      );
      temporaryRoots.push(root);
      return root;
    };

    it("keeps the provider in its own runtime folder", () => {
      const artifact = reviewed();
      const launchPath = makeRuntime("/scient-data").launchPath(artifact);
      expect(launchPath.replaceAll("\\", "/")).toMatch(
        new RegExp(
          `/provider-runtimes/${directory}/versions/${artifact.version.replaceAll(".", "\\.")}/darwin-arm64/${directory}$`,
          "u",
        ),
      );
    });

    it("verifies, activates, reloads, repairs, and removes the reviewed binary", async () => {
      const artifact = reviewed();
      const root = await temporaryRoot();
      const events: string[] = [];
      const dependencies = {
        now: (() => {
          let value = 1;
          return () => value++;
        })(),
        download: async ({ destination, url }: { destination: string; url: string }) => {
          events.push(`download:${url}`);
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.writeFile(destination, `reviewed-${directory}`, { flag: "wx" });
        },
        verify: async (filePath: string, checksum: ManagedRuntimeChecksum) => {
          expect(await NodeFSP.readFile(filePath, "utf8")).toBe(`reviewed-${directory}`);
          expect(checksum).toEqual(artifact.checksum);
          events.push(`verify:${checksum.algorithm}`);
        },
        materialize: async ({
          destination,
          executablePath,
          platform,
        }: {
          destination: string;
          executablePath: string;
          platform: string;
        }) => {
          expect(platform).toBe("darwin");
          await NodeFSP.mkdir(destination, { recursive: true });
          const executable = NodePath.join(destination, executablePath);
          await NodeFSP.writeFile(executable, `${directory}-executable`, { mode: 0o755 });
          events.push(`materialize:${executablePath}`);
          return executable;
        },
        smoke: async (
          executable: string,
          args: ReadonlyArray<string>,
          displayName: string,
          environment?: Readonly<Record<string, string>>,
        ) => {
          expect(await NodeFSP.readFile(executable, "utf8")).toBe(`${directory}-executable`);
          expect(args).toEqual(["--version"]);
          expect(displayName).toBe(name);
          expect(environment).toEqual(smokeEnvironment);
          events.push(`smoke:${NodePath.basename(executable)}`);
        },
      };
      const runtime = makeRuntime(root, dependencies);

      const installed = await runtime.install({ artifact, signal: new AbortController().signal });
      expect(installed).toMatchObject({ installed: true, activeVersion: artifact.version });
      expect(events).toEqual([
        `download:${artifact.url}`,
        `verify:${algorithm}`,
        `materialize:${directory}`,
        `smoke:${directory}`,
      ]);

      expect(await makeRuntime(root, dependencies).status(artifact)).toEqual(installed);

      await runtime.install({ artifact, signal: new AbortController().signal });
      expect(events.filter((event) => event === `verify:${algorithm}`)).toHaveLength(2);
      expect(events.filter((event) => event === `smoke:${directory}`)).toHaveLength(2);

      await runtime.remove();
      await runtime.remove();
      expect((await runtime.status(artifact)).installed).toBe(false);
      expect(await runtime.readState()).toBeUndefined();
    });

    it("never activates a binary whose checksum does not match", async () => {
      const artifact = reviewed();
      const runtime = makeRuntime(await temporaryRoot(), {
        download: async ({ destination }) => {
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.writeFile(destination, "tampered", { flag: "wx" });
        },
        verify: async () => {
          throw new Error(`${algorithm} mismatch`);
        },
      });

      await expect(
        runtime.install({ artifact, signal: new AbortController().signal }),
      ).rejects.toThrow(`${algorithm} mismatch`);
      expect((await runtime.status(artifact)).installed).toBe(false);
      expect(await runtime.readState()).toBeUndefined();
    });
  },
);
