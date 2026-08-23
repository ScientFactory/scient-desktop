// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- This package is the reviewed Node process and filesystem boundary for app-private provider runtimes; orchestration remains in the Effect server layer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import {
  downloadManagedRuntime,
  materializeManagedRuntimeArtifact,
  verifyManagedRuntimeChecksum,
} from "./runtimeFiles.ts";
import { managedRuntimeTargetKey } from "./target.ts";

export type ManagedProviderRuntimeStage =
  | "preparing"
  | "downloading"
  | "verifying"
  | "installing"
  | "testing"
  | "activating";

export interface ManagedProviderRuntimeProgress {
  readonly stage: ManagedProviderRuntimeStage;
  readonly downloadedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
}

export interface ManagedProviderRuntimeState {
  readonly schemaVersion: 1;
  readonly targetKey: string;
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly executableRelativePath: string;
}

export interface ManagedProviderRuntimeStatus {
  readonly launchPath: string;
  readonly activeVersion: string | null;
  readonly previousVersion: string | null;
  readonly installed: boolean;
}

export class ManagedProviderRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedProviderRuntimeError";
  }
}

const SMOKE_TIMEOUT_MS = 15_000;
const MAX_SMOKE_OUTPUT_BYTES = 64 * 1024;

export function managedRuntimeSmokeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "PATH",
    // Windows process startup and user-scoped runtime directories. These are
    // host coordinates, not provider credentials; native provider binaries
    // may consult them even for a bounded `--version` smoke test.
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ] as const;
  const allowedNames = new Set(allowed.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => value !== undefined && allowedNames.has(key.toLowerCase()),
    ),
  );
}

async function smokeExecutable(
  executable: string,
  args: ReadonlyArray<string>,
  displayName: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, [...args], {
      env: { ...managedRuntimeSmokeEnvironment(process.env), ...environment },
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
        finish(
          new ManagedProviderRuntimeError(
            `Managed ${displayName} smoke test produced excessive output.`,
          ),
        );
      }
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    child.once("error", (cause) =>
      finish(
        new ManagedProviderRuntimeError(`Managed ${displayName} smoke test could not start.`, {
          cause,
        }),
      ),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else {
        finish(
          new ManagedProviderRuntimeError(
            `Managed ${displayName} smoke test failed${signal ? ` with ${signal}` : ` with code ${code ?? "unknown"}`}.`,
          ),
        );
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new ManagedProviderRuntimeError(`Managed ${displayName} smoke test timed out.`));
    }, SMOKE_TIMEOUT_MS);
  });
}

export interface ManagedProviderRuntimeDependencies {
  readonly download: typeof downloadManagedRuntime;
  readonly verify: typeof verifyManagedRuntimeChecksum;
  readonly materialize: typeof materializeManagedRuntimeArtifact;
  readonly smoke: (
    executable: string,
    args: ReadonlyArray<string>,
    displayName: string,
    environment?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly commitState: (
    statePath: string,
    state: ManagedProviderRuntimeState,
    nonce: number,
  ) => Promise<void>;
  readonly now: () => number;
}

export interface ManagedProviderRuntimeIdentity {
  readonly providerDirectory: string;
  readonly displayName: string;
}

async function commitManagedRuntimeState(
  statePath: string,
  state: ManagedProviderRuntimeState,
  nonce: number,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.${nonce}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await NodeFSP.rename(temporary, statePath);
}

const DEFAULT_DEPENDENCIES: ManagedProviderRuntimeDependencies = {
  download: downloadManagedRuntime,
  verify: verifyManagedRuntimeChecksum,
  materialize: materializeManagedRuntimeArtifact,
  smoke: smokeExecutable,
  commitState: commitManagedRuntimeState,
  now: Date.now,
};

function decodeState(value: unknown): ManagedProviderRuntimeState | undefined {
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
  return state as unknown as ManagedProviderRuntimeState;
}

export class ManagedProviderRuntime {
  readonly #root: string;
  readonly #statePath: string;
  readonly #versionsDir: string;
  readonly #stagingDir: string;
  readonly #dependencies: ManagedProviderRuntimeDependencies;
  readonly #displayName: string;

  constructor(
    baseDir: string,
    identity: ManagedProviderRuntimeIdentity,
    dependencies?: Partial<ManagedProviderRuntimeDependencies>,
  ) {
    this.#root = NodePath.join(baseDir, "provider-runtimes", identity.providerDirectory);
    this.#statePath = NodePath.join(this.#root, "state.json");
    this.#versionsDir = NodePath.join(this.#root, "versions");
    this.#stagingDir = NodePath.join(this.#root, "staging");
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.#displayName = identity.displayName;
  }

  launchPath(artifact: ManagedRuntimeArtifact): string {
    return NodePath.join(
      this.#versionsDir,
      artifact.version,
      managedRuntimeTargetKey(artifact.target),
      artifact.executablePath,
    );
  }

  async readState(): Promise<ManagedProviderRuntimeState | undefined> {
    try {
      return decodeState(JSON.parse(await NodeFSP.readFile(this.#statePath, "utf8")) as unknown);
    } catch {
      return undefined;
    }
  }

  async status(artifact: ManagedRuntimeArtifact): Promise<ManagedProviderRuntimeStatus> {
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
    readonly onProgress?: (progress: ManagedProviderRuntimeProgress) => void;
  }): Promise<ManagedProviderRuntimeStatus> {
    const { artifact, signal, onProgress } = input;
    if (artifact.supportTier !== "fully_assisted") {
      throw new ManagedProviderRuntimeError(artifact.supportMessage);
    }
    await this.reconcile(artifact);
    await this.#cleanStaging();
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
      await this.#dependencies.verify(archivePath, artifact.checksum);
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
      await this.#dependencies.smoke(
        stagedExecutable,
        artifact.smokeArgs,
        this.#displayName,
        artifact.smokeEnvironment,
      );
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
      const previousVersion =
        previousState?.activeVersion && previousState.activeVersion !== artifact.version
          ? previousState.activeVersion
          : (previousState?.previousVersion ?? null);
      try {
        await this.#writeState({
          schemaVersion: 1,
          targetKey: managedRuntimeTargetKey(artifact.target),
          activeVersion: artifact.version,
          previousVersion,
          executableRelativePath: NodePath.relative(this.#root, this.launchPath(artifact)),
        });
      } catch (cause) {
        try {
          await NodeFSP.rm(destination, { recursive: true, force: true });
          if (hadExisting) await NodeFSP.rename(replaced, destination);
        } catch (rollbackCause) {
          throw new ManagedProviderRuntimeError(
            `Managed ${this.#displayName} activation failed and the previous runtime could not be restored.`,
            { cause: new AggregateError([cause, rollbackCause]) },
          );
        }
        throw cause;
      }
      if (hadExisting) {
        await NodeFSP.rm(replaced, { recursive: true, force: true }).catch(() => undefined);
      }
      return await this.status(artifact);
    } catch (cause) {
      throw cause instanceof Error
        ? cause
        : new ManagedProviderRuntimeError(`Managed ${this.#displayName} installation failed.`, {
            cause,
          });
    } finally {
      await NodeFSP.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(): Promise<void> {
    const parent = NodePath.dirname(this.#root);
    const tombstone = NodePath.join(
      parent,
      `${NodePath.basename(this.#root)}.removing-${process.pid}-${this.#dependencies.now()}`,
    );
    try {
      // Make the managed runtime disappear atomically before recursively
      // deleting it. A concurrent probe therefore sees either the complete
      // runtime or no runtime, never a half-deleted version directory.
      await NodeFSP.rename(this.#root, tombstone);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ManagedProviderRuntimeError(
        `Managed ${this.#displayName} could not be prepared for removal.`,
        { cause },
      );
    }

    try {
      await NodeFSP.rm(tombstone, { recursive: true, force: true });
    } catch (cause) {
      try {
        await NodeFSP.rename(tombstone, this.#root);
      } catch (rollbackCause) {
        throw new ManagedProviderRuntimeError(
          `Managed ${this.#displayName} removal failed and its private runtime could not be restored.`,
          { cause: new AggregateError([cause, rollbackCause]) },
        );
      }
      throw new ManagedProviderRuntimeError(
        `Managed ${this.#displayName} removal failed; the previous private runtime was restored.`,
        { cause },
      );
    }
  }

  async #writeState(state: ManagedProviderRuntimeState): Promise<void> {
    await this.#dependencies.commitState(this.#statePath, state, this.#dependencies.now());
  }

  async #cleanStaging(): Promise<void> {
    const entries = await NodeFSP.readdir(this.#stagingDir).catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        NodeFSP.rm(NodePath.join(this.#stagingDir, entry), { recursive: true, force: true }).catch(
          () => undefined,
        ),
      ),
    );
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
