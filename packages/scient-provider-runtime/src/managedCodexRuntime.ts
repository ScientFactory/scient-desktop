// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- This package is the reviewed Node process and filesystem boundary for app-private provider runtimes; orchestration remains in the Effect server layer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ManagedRuntimeArtifact } from "./codexManifest.ts";
import {
  downloadManagedRuntime,
  materializeManagedRuntimeArtifact,
  verifySha256,
} from "./runtimeFiles.ts";
import { managedRuntimeTargetKey } from "./target.ts";

export type ManagedCodexRuntimeStage =
  | "preparing"
  | "downloading"
  | "verifying"
  | "installing"
  | "testing"
  | "activating";

export interface ManagedCodexRuntimeProgress {
  readonly stage: ManagedCodexRuntimeStage;
  readonly downloadedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
}

export interface ManagedCodexRuntimeState {
  readonly schemaVersion: 1;
  readonly targetKey: string;
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly executableRelativePath: string;
}

export interface ManagedCodexRuntimeStatus {
  readonly launchPath: string;
  readonly activeVersion: string | null;
  readonly previousVersion: string | null;
  readonly installed: boolean;
}

export class ManagedCodexRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedCodexRuntimeError";
  }
}

const SMOKE_TIMEOUT_MS = 15_000;
const MAX_SMOKE_OUTPUT_BYTES = 64 * 1024;

function safeSmokeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}

async function smokeExecutable(executable: string, args: ReadonlyArray<string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, [...args], {
      env: safeSmokeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const count = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_SMOKE_OUTPUT_BYTES) {
        child.kill();
        finish(new ManagedCodexRuntimeError("Managed Codex smoke test produced excessive output."));
      }
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    child.once("error", (cause) =>
      finish(new ManagedCodexRuntimeError("Managed Codex smoke test could not start.", { cause })),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else {
        finish(
          new ManagedCodexRuntimeError(
            `Managed Codex smoke test failed${signal ? ` with ${signal}` : ` with code ${code ?? "unknown"}`}.`,
          ),
        );
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new ManagedCodexRuntimeError("Managed Codex smoke test timed out."));
    }, SMOKE_TIMEOUT_MS);
  });
}

export interface ManagedCodexRuntimeDependencies {
  readonly download: typeof downloadManagedRuntime;
  readonly verify: typeof verifySha256;
  readonly materialize: typeof materializeManagedRuntimeArtifact;
  readonly smoke: (executable: string, args: ReadonlyArray<string>) => Promise<void>;
  readonly now: () => number;
}

const DEFAULT_DEPENDENCIES: ManagedCodexRuntimeDependencies = {
  download: downloadManagedRuntime,
  verify: verifySha256,
  materialize: materializeManagedRuntimeArtifact,
  smoke: smokeExecutable,
  now: Date.now,
};

function decodeState(value: unknown): ManagedCodexRuntimeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.targetKey !== "string" ||
    typeof state.activeVersion !== "string" ||
    !(state.previousVersion === null || typeof state.previousVersion === "string") ||
    typeof state.executableRelativePath !== "string" ||
    NodePath.isAbsolute(state.executableRelativePath) ||
    state.executableRelativePath.split(/[\\/]/u).includes("..")
  ) {
    return undefined;
  }
  return state as unknown as ManagedCodexRuntimeState;
}

export class ManagedCodexRuntime {
  readonly #root: string;
  readonly #statePath: string;
  readonly #versionsDir: string;
  readonly #stagingDir: string;
  readonly #dependencies: ManagedCodexRuntimeDependencies;

  constructor(baseDir: string, dependencies?: Partial<ManagedCodexRuntimeDependencies>) {
    this.#root = NodePath.join(baseDir, "provider-runtimes", "codex");
    this.#statePath = NodePath.join(this.#root, "state.json");
    this.#versionsDir = NodePath.join(this.#root, "versions");
    this.#stagingDir = NodePath.join(this.#root, "staging");
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  launchPath(artifact: ManagedRuntimeArtifact): string {
    return NodePath.join(
      this.#versionsDir,
      artifact.version,
      managedRuntimeTargetKey(artifact.target),
      artifact.executablePath,
    );
  }

  async readState(): Promise<ManagedCodexRuntimeState | undefined> {
    try {
      return decodeState(JSON.parse(await NodeFSP.readFile(this.#statePath, "utf8")) as unknown);
    } catch {
      return undefined;
    }
  }

  async status(artifact: ManagedRuntimeArtifact): Promise<ManagedCodexRuntimeStatus> {
    const state = await this.readState();
    const activeState =
      state?.targetKey === managedRuntimeTargetKey(artifact.target) ? state : undefined;
    // A newly reviewed artifact may be newer than the currently active copy.
    // Keep reporting (and launching) the last atomically activated executable
    // until the new artifact has been downloaded, verified, smoke-tested, and
    // activated. Treating only the catalog version as installed would make a
    // healthy older copy disappear during an app update.
    const launchPath = activeState
      ? NodePath.resolve(this.#root, activeState.executableRelativePath)
      : this.launchPath(artifact);
    const installed = await NodeFSP.access(launchPath).then(
      () => true,
      () => false,
    );
    return {
      launchPath,
      installed,
      activeVersion: activeState?.activeVersion ?? null,
      previousVersion: activeState?.previousVersion ?? null,
    };
  }

  async reconcile(artifact?: ManagedRuntimeArtifact): Promise<void> {
    await NodeFSP.mkdir(this.#stagingDir, { recursive: true, mode: 0o700 });
    const entries = await NodeFSP.readdir(this.#stagingDir).catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        NodeFSP.rm(NodePath.join(this.#stagingDir, entry), { recursive: true, force: true }).catch(
          () => undefined,
        ),
      ),
    );
    const rootEntries = await NodeFSP.readdir(this.#root).catch(() => []);
    await Promise.all(
      rootEntries
        .filter((entry) => entry.startsWith("state.json.") && entry.endsWith(".tmp"))
        .map((entry) => NodeFSP.rm(NodePath.join(this.#root, entry), { force: true })),
    );
    if (artifact) await this.#reconcileReplacement(artifact);
  }

  async install(input: {
    readonly artifact: ManagedRuntimeArtifact;
    readonly signal: AbortSignal;
    readonly onProgress?: (progress: ManagedCodexRuntimeProgress) => void;
  }): Promise<ManagedCodexRuntimeStatus> {
    const { artifact, signal, onProgress } = input;
    if (artifact.supportTier !== "fully_assisted") {
      throw new ManagedCodexRuntimeError(artifact.supportMessage);
    }
    await this.reconcile(artifact);
    onProgress?.({ stage: "preparing" });
    const stage = await NodeFSP.mkdtemp(NodePath.join(this.#stagingDir, "install-"));
    const archivePath = NodePath.join(stage, artifact.artifactName);
    const payloadPath = NodePath.join(stage, "payload");
    const destination = NodePath.join(
      this.#versionsDir,
      artifact.version,
      managedRuntimeTargetKey(artifact.target),
    );
    const previousState = await this.readState();

    try {
      onProgress?.({
        stage: "downloading",
        downloadedBytes: 0,
        totalBytes: artifact.size,
      });
      await this.#dependencies.download({
        url: artifact.url,
        destination: archivePath,
        allowedHosts: artifact.allowedHosts,
        expectedSize: artifact.size,
        signal,
        onProgress: (downloadedBytes, totalBytes) =>
          onProgress?.({ stage: "downloading", downloadedBytes, totalBytes }),
      });
      onProgress?.({ stage: "verifying" });
      await this.#dependencies.verify(archivePath, artifact.sha256);
      onProgress?.({ stage: "installing" });
      const stagedExecutable = await this.#dependencies.materialize({
        archivePath,
        archiveFormat: artifact.archiveFormat,
        destination: payloadPath,
        executablePath: artifact.executablePath,
        platform: artifact.target.platform,
        signal,
      });
      onProgress?.({ stage: "testing" });
      await this.#dependencies.smoke(stagedExecutable, artifact.smokeArgs);
      if (signal.aborted) throw new DOMException("Installation cancelled.", "AbortError");
      onProgress?.({ stage: "activating" });
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
      const replaced = `${destination}.replaced-${this.#dependencies.now()}`;
      const hadExisting = await NodeFSP.access(destination).then(
        () => true,
        () => false,
      );
      if (hadExisting) await NodeFSP.rename(destination, replaced);
      try {
        await NodeFSP.rename(payloadPath, destination);
      } catch (cause) {
        if (hadExisting) await NodeFSP.rename(replaced, destination).catch(() => undefined);
        throw cause;
      }
      if (hadExisting) await NodeFSP.rm(replaced, { recursive: true, force: true });
      const previousVersion =
        previousState?.activeVersion && previousState.activeVersion !== artifact.version
          ? previousState.activeVersion
          : (previousState?.previousVersion ?? null);
      await this.#writeState({
        schemaVersion: 1,
        targetKey: managedRuntimeTargetKey(artifact.target),
        activeVersion: artifact.version,
        previousVersion,
        executableRelativePath: NodePath.relative(this.#root, this.launchPath(artifact)),
      });
      return await this.status(artifact);
    } catch (cause) {
      throw cause instanceof Error
        ? cause
        : new ManagedCodexRuntimeError("Managed Codex installation failed.", { cause });
    } finally {
      await NodeFSP.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(): Promise<void> {
    await NodeFSP.rm(this.#root, { recursive: true, force: true });
  }

  async #writeState(state: ManagedCodexRuntimeState): Promise<void> {
    await NodeFSP.mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporary = `${this.#statePath}.${process.pid}.${this.#dependencies.now()}.tmp`;
    await NodeFSP.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await NodeFSP.rename(temporary, this.#statePath);
  }

  async #reconcileReplacement(artifact: ManagedRuntimeArtifact): Promise<void> {
    const destination = NodePath.dirname(this.launchPath(artifact));
    const parent = NodePath.dirname(destination);
    const destinationName = NodePath.basename(destination);
    const replacementPrefix = `${destinationName}.replaced-`;
    const entries = await NodeFSP.readdir(parent, { withFileTypes: true }).catch(() => []);
    const replacements = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(replacementPrefix))
      .map((entry) => entry.name)
      .sort()
      .toReversed();
    if (replacements.length === 0) return;

    const destinationExists = await NodeFSP.access(destination).then(
      () => true,
      () => false,
    );
    if (!destinationExists) {
      const [newest, ...older] = replacements;
      if (newest) await NodeFSP.rename(NodePath.join(parent, newest), destination);
      await Promise.all(
        older.map((entry) =>
          NodeFSP.rm(NodePath.join(parent, entry), { recursive: true, force: true }),
        ),
      );
      return;
    }

    await Promise.all(
      replacements.map((entry) =>
        NodeFSP.rm(NodePath.join(parent, entry), { recursive: true, force: true }),
      ),
    );
  }
}
