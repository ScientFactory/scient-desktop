// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import {
  ManagedProviderRuntime,
  managedRuntimeSmokeEnvironment,
  type ManagedProviderRuntimeDependencies,
} from "./managedProviderRuntime.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function artifact(
  version: string,
  overrides: Partial<ManagedRuntimeArtifact> = {},
): ManagedRuntimeArtifact {
  return {
    provider: "codex",
    version,
    target: { platform: "darwin", arch: "arm64" },
    artifactName: `provider-${version}`,
    url: `https://example.com/provider-${version}`,
    allowedHosts: ["example.com"],
    allowedUrlPathPrefixes: ["/"],
    checksum: { algorithm: "sha256", digest: "0".repeat(64) },
    size: 5,
    archiveFormat: "raw",
    executablePath: "provider",
    smokeArgs: ["--version"],
    catalogRevision: `test:${version}`,
    supportTier: "fully_assisted",
    supportMessage: "Test target.",
    ...overrides,
  };
}

async function makeRuntime(
  input: {
    readonly verifyFailsAtCall?: number;
    readonly smokeFailsAtCall?: number;
    readonly stateCommitFailsAtCall?: number;
    readonly onSmoke?: () => void;
  } = {},
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-provider-runtime-"));
  temporaryRoots.push(root);
  const events: string[] = [];
  let now = 1;
  let materializeCalls = 0;
  let verifyCalls = 0;
  let smokeCalls = 0;
  let stateCommitCalls = 0;
  const dependencies: Partial<ManagedProviderRuntimeDependencies> = {
    now: () => now++,
    download: async ({ destination }) => {
      events.push("download");
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.writeFile(destination, "asset", { flag: "wx" });
    },
    verify: async () => {
      verifyCalls += 1;
      events.push("verify");
      if (input.verifyFailsAtCall === verifyCalls) throw new Error("verification failed");
    },
    materialize: async ({ destination, executablePath }) => {
      materializeCalls += 1;
      events.push("materialize");
      await NodeFSP.mkdir(destination, { recursive: true });
      const executable = NodePath.join(destination, executablePath);
      await NodeFSP.writeFile(executable, `install ${materializeCalls}`, { mode: 0o755 });
      return executable;
    },
    smoke: async () => {
      smokeCalls += 1;
      events.push("smoke");
      input.onSmoke?.();
      if (input.smokeFailsAtCall === smokeCalls) throw new Error("smoke failed");
    },
    commitState: async (statePath, state, nonce) => {
      stateCommitCalls += 1;
      events.push("commit");
      if (input.stateCommitFailsAtCall === stateCommitCalls) {
        throw new Error("state commit failed");
      }
      await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
      const temporary = `${statePath}.${nonce}.tmp`;
      await NodeFSP.writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx" });
      await NodeFSP.rename(temporary, statePath);
    },
  };
  const runtime = new ManagedProviderRuntime(
    root,
    { providerDirectory: "test-provider", displayName: "Test Provider" },
    dependencies,
  );
  return { root, runtime, events };
}

async function install(
  runtime: ManagedProviderRuntime,
  recipe: ManagedRuntimeArtifact,
  signal: AbortSignal = new AbortController().signal,
) {
  return runtime.install({ artifact: recipe, signal });
}

function privateRoot(root: string): string {
  return NodePath.join(root, "provider-runtimes", "test-provider");
}

function statePath(root: string): string {
  return NodePath.join(privateRoot(root), "state.json");
}

function activationPath(root: string): string {
  return NodePath.join(privateRoot(root), "activation.json");
}

describe("managed provider runtime smoke environment", () => {
  it("keeps credential-free Windows host coordinates without forwarding provider secrets", () => {
    const environment = managedRuntimeSmokeEnvironment({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\scientist",
      APPDATA: "C:\\Users\\scientist\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\scientist\\AppData\\Local",
      TEMP: "C:\\Users\\scientist\\AppData\\Local\\Temp",
      ANTHROPIC_API_KEY: "must-not-reach-smoke-test",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-smoke-test",
      OPENAI_API_KEY: "must-not-reach-smoke-test",
    });

    expect(environment).toMatchObject({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\scientist",
      APPDATA: "C:\\Users\\scientist\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\scientist\\AppData\\Local",
      TEMP: "C:\\Users\\scientist\\AppData\\Local\\Temp",
    });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("ManagedProviderRuntime contract", () => {
  it("runs the reviewed install stages in order before recording activation", async () => {
    const { root, runtime, events } = await makeRuntime();
    const stages: string[] = [];

    const status = await runtime.install({
      artifact: artifact("1.0.0"),
      signal: new AbortController().signal,
      onProgress: ({ stage }) => stages.push(stage),
    });

    expect(status).toMatchObject({
      installed: true,
      activeVersion: "1.0.0",
      selected: true,
    });
    expect(JSON.parse(await NodeFSP.readFile(statePath(root), "utf8"))).toMatchObject({
      schemaVersion: 3,
      selection: "managed",
      activeArtifact: {
        provider: "codex",
        version: "1.0.0",
        catalogRevision: "test:1.0.0",
      },
      previousArtifact: null,
    });
    expect(stages).toEqual([
      "preparing",
      "downloading",
      "verifying",
      "installing",
      "testing",
      "activating",
    ]);
    expect(events).toEqual(["download", "verify", "materialize", "smoke", "commit"]);
  });

  it("reads legacy state without silently treating it as an explicit managed selection", async () => {
    const { root, runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    await install(runtime, recipe);
    const current = await runtime.readState();
    expect(current).toBeDefined();
    await NodeFSP.writeFile(
      statePath(root),
      `${JSON.stringify({
        schemaVersion: 1,
        targetKey: current!.targetKey,
        activeVersion: current!.activeVersion,
        previousVersion: current!.previousVersion,
        executableRelativePath: current!.executableRelativePath,
      })}\n`,
    );

    expect(await runtime.status(recipe)).toMatchObject({
      installed: true,
      activeVersion: "1.0.0",
      selected: false,
    });
  });

  it("upgrades explicit v2 state on the next successful operation without losing legacy history", async () => {
    const { root, runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    await install(runtime, recipe);
    const current = await runtime.readState();
    expect(current).toBeDefined();
    await NodeFSP.writeFile(
      statePath(root),
      `${JSON.stringify({
        schemaVersion: 2,
        selection: "managed",
        targetKey: current!.targetKey,
        activeVersion: current!.activeVersion,
        previousVersion: "0.9.0",
        executableRelativePath: current!.executableRelativePath,
      })}\n`,
    );

    await install(runtime, recipe);

    expect(await runtime.readState()).toMatchObject({
      schemaVersion: 3,
      activeVersion: "1.0.0",
      previousVersion: "0.9.0",
      activeArtifact: { catalogRevision: "test:1.0.0" },
      previousArtifact: null,
    });
  });

  it("activates an update while recording and preserving the previous version", async () => {
    const { root, runtime } = await makeRuntime();
    const first = await install(runtime, artifact("1.0.0"));

    const updated = await install(runtime, artifact("2.0.0"));

    expect(updated).toMatchObject({
      installed: true,
      activeVersion: "2.0.0",
      previousVersion: "1.0.0",
    });
    expect(updated.launchPath).not.toBe(first.launchPath);
    expect(await NodeFSP.readFile(first.launchPath, "utf8")).toBe("install 1");
    expect(await NodeFSP.readFile(updated.launchPath, "utf8")).toBe("install 2");
    expect(JSON.parse(await NodeFSP.readFile(statePath(root), "utf8"))).toMatchObject({
      activeArtifact: { version: "2.0.0", catalogRevision: "test:2.0.0" },
      previousArtifact: { version: "1.0.0", catalogRevision: "test:1.0.0" },
    });
  });

  it("qualifies the final path before committing activation", async () => {
    const { root, runtime, events } = await makeRuntime();
    const recipe = artifact("1.0.0");

    const status = await runtime.install({
      artifact: recipe,
      signal: new AbortController().signal,
      qualify: async ({ artifact: candidate, executablePath, payloadPath }) => {
        events.push("qualify");
        expect(candidate).toBe(recipe);
        expect(executablePath).toBe(runtime.launchPath(recipe));
        expect(payloadPath).toBe(NodePath.dirname(executablePath));
        expect(await NodeFSP.readFile(executablePath, "utf8")).toBe("install 1");
        expect(await runtime.readState()).toBeUndefined();
      },
    });

    expect(status).toMatchObject({ installed: true, activeVersion: "1.0.0" });
    expect(events).toEqual(["download", "verify", "materialize", "smoke", "qualify", "commit"]);
    expect(JSON.parse(await NodeFSP.readFile(statePath(root), "utf8"))).toMatchObject({
      activeVersion: "1.0.0",
    });
  });

  it("restores the active runtime when final-path qualification rejects an update", async () => {
    const { runtime } = await makeRuntime();
    const first = artifact("1.0.0");
    const installed = await install(runtime, first);
    const replacement = artifact("2.0.0");

    await expect(
      runtime.install({
        artifact: replacement,
        signal: new AbortController().signal,
        qualify: async () => {
          throw new Error("runtime incompatible");
        },
      }),
    ).rejects.toThrow("runtime incompatible");

    expect(await runtime.readState()).toMatchObject({ activeVersion: "1.0.0" });
    expect(await NodeFSP.readFile(installed.launchPath, "utf8")).toBe("install 1");
    await expect(NodeFSP.access(runtime.launchPath(replacement))).rejects.toThrow();
  });

  it("keeps launching the active release while a newer artifact is only reviewed", async () => {
    const { runtime } = await makeRuntime();
    const installed = await install(runtime, artifact("1.0.0"));

    const status = await runtime.status(artifact("2.0.0"));

    expect(status).toMatchObject({ installed: true, activeVersion: "1.0.0" });
    expect(status.launchPath).toBe(installed.launchPath);
  });

  it("repairs the reviewed version without inventing a previous release", async () => {
    const { runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    const first = await install(runtime, recipe);

    const repaired = await install(runtime, recipe);

    expect(repaired).toMatchObject({
      installed: true,
      activeVersion: "1.0.0",
      previousVersion: null,
    });
    expect(repaired.launchPath).toBe(first.launchPath);
    expect(await NodeFSP.readFile(repaired.launchPath, "utf8")).toBe("install 2");
  });

  it("keeps the active runtime and selection when verification rejects a replacement", async () => {
    const { runtime } = await makeRuntime({ verifyFailsAtCall: 2 });
    const first = artifact("1.0.0");
    const installed = await install(runtime, first);

    await expect(install(runtime, artifact("2.0.0"))).rejects.toThrow("verification failed");

    expect(await runtime.readState()).toMatchObject({ activeVersion: "1.0.0" });
    expect(await runtime.status(first)).toMatchObject({
      launchPath: installed.launchPath,
      selected: true,
    });
    expect(await NodeFSP.readFile(installed.launchPath, "utf8")).toBe("install 1");
  });

  it("keeps the active runtime when smoke testing rejects a replacement", async () => {
    const { runtime } = await makeRuntime({ smokeFailsAtCall: 2 });
    const first = artifact("1.0.0");
    const installed = await install(runtime, first);

    await expect(install(runtime, artifact("2.0.0"))).rejects.toThrow("smoke failed");

    expect(await runtime.readState()).toMatchObject({ activeVersion: "1.0.0" });
    expect((await runtime.status(first)).launchPath).toBe(installed.launchPath);
    expect(await NodeFSP.readFile(installed.launchPath, "utf8")).toBe("install 1");
  });

  it("does not activate a staged runtime when cancellation arrives before activation", async () => {
    const controller = new AbortController();
    const { runtime, events } = await makeRuntime({ onSmoke: () => controller.abort() });
    const recipe = artifact("1.0.0");

    await expect(install(runtime, recipe, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(await runtime.readState()).toBeUndefined();
    expect((await runtime.status(recipe)).installed).toBe(false);
    expect((await runtime.status(recipe)).selected).toBe(false);
    expect(events).toEqual(["download", "verify", "materialize", "smoke"]);
  });

  it("restores the active version when activation state cannot be committed", async () => {
    const { root, runtime } = await makeRuntime({ stateCommitFailsAtCall: 2 });
    const recipe = artifact("1.0.0");
    const installed = await install(runtime, recipe);

    await expect(install(runtime, recipe)).rejects.toThrow("state commit failed");

    expect(await runtime.readState()).toMatchObject({ activeVersion: "1.0.0" });
    expect(await NodeFSP.readFile(installed.launchPath, "utf8")).toBe("install 1");
    const targetDirectory = NodePath.dirname(installed.launchPath);
    expect(
      (await NodeFSP.readdir(NodePath.dirname(targetDirectory))).some((entry) =>
        entry.startsWith(`${NodePath.basename(targetDirectory)}.replaced-`),
      ),
    ).toBe(false);
    expect(await NodeFSP.readdir(NodePath.join(privateRoot(root), "staging"))).toEqual([]);
  });

  it("reconciles an interrupted atomic replacement back to the prior runtime", async () => {
    const { root, runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    const installed = await install(runtime, recipe);
    const targetDirectory = NodePath.dirname(installed.launchPath);
    const replacement = `${targetDirectory}.replaced-99`;
    const interruptedState = NodePath.join(privateRoot(root), "state.json.10.99.tmp");
    await NodeFSP.rename(targetDirectory, replacement);
    await NodeFSP.writeFile(interruptedState, "partial");

    await runtime.reconcile(recipe);

    expect((await runtime.status(recipe)).installed).toBe(true);
    await expect(NodeFSP.access(replacement)).rejects.toThrow();
    await expect(NodeFSP.access(interruptedState)).rejects.toThrow();
  });

  it("restores a replaced runtime when final-path qualification was interrupted", async () => {
    const { root, runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    const installed = await install(runtime, recipe);
    const targetDirectory = NodePath.dirname(installed.launchPath);
    const replacement = `${targetDirectory}.replaced-99`;
    await NodeFSP.rename(targetDirectory, replacement);
    await NodeFSP.mkdir(targetDirectory, { recursive: true });
    await NodeFSP.writeFile(installed.launchPath, "unqualified replacement", { mode: 0o755 });
    await NodeFSP.writeFile(
      activationPath(root),
      `${JSON.stringify({
        schemaVersion: 1,
        activationId: "interrupted-activation",
        destinationRelativePath: NodePath.relative(privateRoot(root), targetDirectory),
        replacedRelativePath: NodePath.relative(privateRoot(root), replacement),
      })}\n`,
    );
    await runtime.reconcile(recipe);

    expect(await NodeFSP.readFile(installed.launchPath, "utf8")).toBe("install 1");
    await expect(NodeFSP.access(replacement)).rejects.toThrow();
  });

  it("keeps a committed replacement while cleaning its interrupted backup", async () => {
    const { root, runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    const installed = await install(runtime, recipe);
    const targetDirectory = NodePath.dirname(installed.launchPath);
    const replacement = `${targetDirectory}.replaced-99`;
    await NodeFSP.mkdir(replacement, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(replacement, "provider"), "old runtime", { mode: 0o755 });
    const state = await runtime.readState();
    expect(state?.schemaVersion).toBe(3);
    await NodeFSP.writeFile(
      activationPath(root),
      `${JSON.stringify({
        schemaVersion: 1,
        activationId: state?.schemaVersion === 3 ? state.activationId : "missing",
        destinationRelativePath: NodePath.relative(privateRoot(root), targetDirectory),
        replacedRelativePath: NodePath.relative(privateRoot(root), replacement),
      })}\n`,
    );

    await runtime.reconcile(recipe);

    expect(await NodeFSP.readFile(installed.launchPath, "utf8")).toBe("install 1");
    await expect(NodeFSP.access(replacement)).rejects.toThrow();
  });

  it("does not launch state recorded for another computer target", async () => {
    const { runtime } = await makeRuntime();
    await install(runtime, artifact("1.0.0"));

    const status = await runtime.status(
      artifact("1.0.0", { target: { platform: "darwin", arch: "x64" } }),
    );

    expect(status).toMatchObject({ installed: false, activeVersion: null });
  });

  it("leaves staging ownership alone during reconciliation and cleans it on the next install", async () => {
    const { root, runtime } = await makeRuntime();
    const staging = NodePath.join(privateRoot(root), "staging", "abandoned");
    await NodeFSP.mkdir(staging, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(staging, "partial"), "partial");

    await runtime.reconcile();
    expect(await NodeFSP.readFile(NodePath.join(staging, "partial"), "utf8")).toBe("partial");

    await install(runtime, artifact("1.0.0"));
    await expect(NodeFSP.access(staging)).rejects.toThrow();
  });

  it("removes idempotently without touching siblings or external installations", async () => {
    const { root, runtime } = await makeRuntime();
    const recipe = artifact("1.0.0");
    await install(runtime, recipe);
    const sibling = NodePath.join(root, "provider-runtimes", "other-provider", "keep");
    const external = NodePath.join(root, "system-installation", "provider");
    await NodeFSP.mkdir(NodePath.dirname(sibling), { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(external), { recursive: true });
    await NodeFSP.writeFile(sibling, "keep");
    await NodeFSP.writeFile(external, "external");

    await runtime.remove();
    await runtime.remove();

    expect((await runtime.status(recipe)).installed).toBe(false);
    expect(await runtime.readState()).toBeUndefined();
    expect(await NodeFSP.readFile(sibling, "utf8")).toBe("keep");
    expect(await NodeFSP.readFile(external, "utf8")).toBe("external");
  });

  it("rejects unsupported artifacts before creating managed state", async () => {
    const { root, runtime, events } = await makeRuntime();

    await expect(
      install(
        runtime,
        artifact("1.0.0", {
          supportTier: "external_runtime_supported",
          supportMessage: "Install this runtime outside Scient.",
        }),
      ),
    ).rejects.toThrow("Install this runtime outside Scient.");

    expect(events).toEqual([]);
    await expect(NodeFSP.access(privateRoot(root))).rejects.toThrow();
  });
});

describe("ManagedProviderRuntime ZIP composition", () => {
  it.each(["malformed", "extraction-limit"] as const)(
    "keeps the active runtime when ZIP %s validation fails during install",
    async (failure) => {
      const root = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "scient-provider-runtime-zip-"),
      );
      temporaryRoots.push(root);
      const runtime = new ManagedProviderRuntime(
        root,
        { providerDirectory: "test-provider", displayName: "Test Provider" },
        {
          download: async ({ destination }) => {
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
            if (!destination.endsWith(".zip")) {
              await NodeFSP.writeFile(destination, "working-runtime", { flag: "wx" });
              return;
            }
            if (failure === "malformed") {
              await NodeFSP.writeFile(destination, "not-a-zip", { flag: "wx" });
              return;
            }
            const zip = new JSZip();
            zip.file("provider", "#!/bin/sh\nexit 0\n");
            zip.file("extra.js", "extra");
            await NodeFSP.writeFile(destination, await zip.generateAsync({ type: "nodebuffer" }), {
              flag: "wx",
            });
          },
          verify: async () => undefined,
          smoke: async () => undefined,
        },
      );
      const first = artifact("1.0.0");
      const installed = await install(runtime, first);
      const replacement = artifact("2.0.0", {
        artifactName: "provider.zip",
        archiveFormat: "zip",
        executablePath: "provider",
        extractionLimits: { maxEntries: 1, maxExpandedBytes: 4_096 },
      });

      await expect(install(runtime, replacement)).rejects.toThrow(
        failure === "malformed" ? "ZIP archive could not be opened" : "exceeds extraction limits",
      );

      expect(await runtime.readState()).toMatchObject({ activeVersion: "1.0.0" });
      expect(await NodeFSP.readFile(installed.launchPath, "utf8")).toBe("working-runtime");
      await expect(NodeFSP.access(runtime.launchPath(replacement))).rejects.toThrow();
      expect(await NodeFSP.readdir(NodePath.join(privateRoot(root), "staging"))).toEqual([]);
    },
  );
});
