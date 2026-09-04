// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- This package is the reviewed Node process and filesystem boundary for app-private provider runtimes; orchestration remains in the Effect server layer.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  managedRuntimeArtifactReceipt,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeArtifactReceipt,
} from "./managedRuntimeArtifact.ts";
import {
  downloadManagedRuntime,
  materializeManagedRuntimeArtifact,
  resolveManagedRuntimeArtifactPath,
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

export interface ManagedProviderRuntimeStateV1 {
  readonly schemaVersion: 1;
  readonly targetKey: string;
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly executableRelativePath: string;
}

export interface ManagedProviderRuntimeStateV2 {
  readonly schemaVersion: 2;
  readonly selection: "managed";
  readonly targetKey: string;
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly executableRelativePath: string;
}

export interface ManagedProviderRuntimeStateV3 {
  readonly schemaVersion: 3;
  readonly selection: "managed";
  readonly activationId: string;
  readonly targetKey: string;
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly executableRelativePath: string;
  readonly activeArtifact: ManagedRuntimeArtifactReceipt;
  readonly previousArtifact: ManagedRuntimeArtifactReceipt | null;
}

export type ManagedProviderRuntimeState =
  | ManagedProviderRuntimeStateV1
  | ManagedProviderRuntimeStateV2
  | ManagedProviderRuntimeStateV3;

export interface ManagedProviderRuntimeStatus {
  readonly launchPath: string;
  readonly activeVersion: string | null;
  readonly previousVersion: string | null;
  readonly installed: boolean;
  /** True only after the user explicitly activates a managed runtime with state schema v2+. */
  readonly selected: boolean;
  readonly activeArtifact: ManagedRuntimeArtifactReceipt | null;
  readonly previousArtifact: ManagedRuntimeArtifactReceipt | null;
}

export interface ManagedProviderRuntimeQualificationInput {
  readonly artifact: ManagedRuntimeArtifact;
  readonly executablePath: string;
  readonly payloadPath: string;
  readonly signal: AbortSignal;
}

interface ManagedProviderRuntimeActivation {
  readonly schemaVersion: 1;
  readonly activationId: string;
  readonly destinationRelativePath: string;
  readonly replacedRelativePath: string | null;
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

export async function smokeManagedRuntimeExecutable(
  executable: string,
  args: ReadonlyArray<string>,
  displayName: string,
  environment: Readonly<Record<string, string>> = {},
  options: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...managedRuntimeSmokeEnvironment(process.env), ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let outputBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let terminationRequested = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: Error) => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      failure ??= error;
      // This is only the owned, bounded version probe, never a user session.
      // Wait for close even on failure so staging cleanup cannot race it.
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const onAbort = () => terminate(new DOMException("Installation cancelled.", "AbortError"));
    const count = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_SMOKE_OUTPUT_BYTES) {
        terminate(
          new ManagedProviderRuntimeError(
            `Managed ${displayName} smoke test produced excessive output.`,
          ),
        );
      }
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    child.once("error", (cause) => {
      failure ??= new ManagedProviderRuntimeError(
        `Managed ${displayName} smoke test could not start.`,
        {
          cause,
        },
      );
    });
    // exit may precede stdio closure; Windows cannot reliably rename the
    // package while probe-owned handles are still being released.
    child.once("close", (code, signal) => {
      if (failure) finish(failure);
      else if (code === 0) finish();
      else {
        finish(
          new ManagedProviderRuntimeError(
            `Managed ${displayName} smoke test failed${signal ? ` with ${signal}` : ` with code ${code ?? "unknown"}`}.`,
          ),
        );
      }
    });
    const timer = setTimeout(() => {
      terminate(new ManagedProviderRuntimeError(`Managed ${displayName} smoke test timed out.`));
    }, SMOKE_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
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
    options?: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined },
  ) => Promise<void>;
  readonly commitState: (
    statePath: string,
    state: ManagedProviderRuntimeState,
    nonce: number,
  ) => Promise<void>;
  readonly now: () => number;
  readonly activationId: () => string;
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
  smoke: smokeManagedRuntimeExecutable,
  commitState: commitManagedRuntimeState,
  now: Date.now,
  activationId: NodeCrypto.randomUUID,
};

const MANAGED_RUNTIME_PROVIDERS = new Set([
  "codex",
  "claudeAgent",
  "antigravity",
  "cursor",
  "droid",
  "grok",
]);

function decodeArtifactReceipt(value: unknown): ManagedRuntimeArtifactReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  const target = receipt.target;
  const checksum = receipt.checksum;
  if (
    typeof receipt.provider !== "string" ||
    !MANAGED_RUNTIME_PROVIDERS.has(receipt.provider) ||
    typeof receipt.version !== "string" ||
    receipt.version.length === 0 ||
    typeof receipt.artifactName !== "string" ||
    receipt.artifactName.length === 0 ||
    typeof receipt.url !== "string" ||
    receipt.url.length === 0 ||
    typeof receipt.size !== "number" ||
    !Number.isSafeInteger(receipt.size) ||
    receipt.size <= 0 ||
    typeof receipt.catalogRevision !== "string" ||
    receipt.catalogRevision.length === 0 ||
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    !checksum ||
    typeof checksum !== "object" ||
    Array.isArray(checksum)
  ) {
    return undefined;
  }
  const targetRecord = target as Record<string, unknown>;
  const checksumRecord = checksum as Record<string, unknown>;
  if (
    !(
      targetRecord.platform === "darwin" ||
      targetRecord.platform === "linux" ||
      targetRecord.platform === "win32"
    ) ||
    !(targetRecord.arch === "arm64" || targetRecord.arch === "x64") ||
    (targetRecord.platform === "linux"
      ? !(targetRecord.libc === "glibc" || targetRecord.libc === "musl")
      : targetRecord.libc !== undefined) ||
    !(checksumRecord.algorithm === "sha256" || checksumRecord.algorithm === "sha512") ||
    typeof checksumRecord.digest !== "string" ||
    !/^[0-9a-f]+$/u.test(checksumRecord.digest) ||
    checksumRecord.digest.length !== (checksumRecord.algorithm === "sha256" ? 64 : 128) ||
    receipt.artifactName === "." ||
    receipt.artifactName === ".." ||
    NodePath.basename(receipt.artifactName as string) !== receipt.artifactName ||
    !URL.canParse(receipt.url as string) ||
    new URL(receipt.url as string).protocol !== "https:"
  ) {
    return undefined;
  }
  return receipt as unknown as ManagedRuntimeArtifactReceipt;
}

function decodeState(value: unknown): ManagedProviderRuntimeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (
    !(state.schemaVersion === 1 || state.schemaVersion === 2 || state.schemaVersion === 3) ||
    ((state.schemaVersion === 2 || state.schemaVersion === 3) && state.selection !== "managed") ||
    (state.schemaVersion === 3 &&
      (typeof state.activationId !== "string" || state.activationId.length === 0)) ||
    typeof state.targetKey !== "string" ||
    typeof state.activeVersion !== "string" ||
    !(state.previousVersion === null || typeof state.previousVersion === "string") ||
    typeof state.executableRelativePath !== "string" ||
    state.executableRelativePath.length === 0 ||
    state.executableRelativePath === "." ||
    NodePath.isAbsolute(state.executableRelativePath) ||
    state.executableRelativePath.split(/[\\/]/u).includes("..")
  ) {
    return undefined;
  }
  if (state.schemaVersion === 3) {
    const activeArtifact = decodeArtifactReceipt(state.activeArtifact);
    const previousArtifact =
      state.previousArtifact === null ? null : decodeArtifactReceipt(state.previousArtifact);
    if (
      !activeArtifact ||
      previousArtifact === undefined ||
      activeArtifact.version !== state.activeVersion ||
      (previousArtifact !== null && previousArtifact.version !== state.previousVersion) ||
      managedRuntimeTargetKey(activeArtifact.target) !== state.targetKey ||
      (previousArtifact !== null &&
        managedRuntimeTargetKey(previousArtifact.target) !== state.targetKey)
    ) {
      return undefined;
    }
  }
  return state as unknown as ManagedProviderRuntimeState;
}

function decodeActivation(value: unknown): ManagedProviderRuntimeActivation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const activation = value as Record<string, unknown>;
  if (
    activation.schemaVersion !== 1 ||
    typeof activation.activationId !== "string" ||
    activation.activationId.length === 0 ||
    typeof activation.destinationRelativePath !== "string" ||
    activation.destinationRelativePath.length === 0 ||
    activation.destinationRelativePath.split(/[\\/]/u)[0] !== "versions" ||
    NodePath.isAbsolute(activation.destinationRelativePath) ||
    activation.destinationRelativePath.split(/[\\/]/u).includes("..") ||
    !(
      activation.replacedRelativePath === null ||
      (typeof activation.replacedRelativePath === "string" &&
        activation.replacedRelativePath.length > 0 &&
        activation.replacedRelativePath.split(/[\\/]/u)[0] === "versions" &&
        !NodePath.isAbsolute(activation.replacedRelativePath) &&
        !activation.replacedRelativePath.split(/[\\/]/u).includes(".."))
    )
  ) {
    return undefined;
  }
  return activation as unknown as ManagedProviderRuntimeActivation;
}

export class ManagedProviderRuntime {
  readonly #root: string;
  readonly #statePath: string;
  readonly #activationPath: string;
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
    this.#activationPath = NodePath.join(this.#root, "activation.json");
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
      selected: activeState?.schemaVersion === 2 || activeState?.schemaVersion === 3,
      activeArtifact: activeState?.schemaVersion === 3 ? activeState.activeArtifact : null,
      previousArtifact: activeState?.schemaVersion === 3 ? activeState.previousArtifact : null,
    };
  }

  async reconcile(artifact?: ManagedRuntimeArtifact): Promise<void> {
    await NodeFSP.mkdir(this.#stagingDir, { recursive: true, mode: 0o700 });
    const rootEntries = await NodeFSP.readdir(this.#root).catch(() => []);
    await Promise.all(
      rootEntries
        .filter(
          (entry) =>
            (entry.startsWith("state.json.") || entry.startsWith("activation.json.")) &&
            entry.endsWith(".tmp"),
        )
        .map((entry) => NodeFSP.rm(NodePath.join(this.#root, entry), { force: true })),
    );
    await this.#reconcileActivation();
    if (artifact) await this.#reconcileReplacement(artifact);
  }

  async install(input: {
    readonly artifact: ManagedRuntimeArtifact;
    readonly signal: AbortSignal;
    readonly onProgress?: (progress: ManagedProviderRuntimeProgress) => void;
    readonly qualify?: (input: ManagedProviderRuntimeQualificationInput) => Promise<void>;
  }): Promise<ManagedProviderRuntimeStatus> {
    const { artifact, signal, onProgress, qualify } = input;
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
        auxiliaryExecutablePaths: artifact.auxiliaryExecutablePaths,
        platform: artifact.target.platform,
        extractionLimits: artifact.extractionLimits,
        signal,
      });
      onProgress?.({ stage: "testing" });
      const smokeExecutablePath = artifact.smokeExecutablePath
        ? resolveManagedRuntimeArtifactPath(payloadPath, artifact.smokeExecutablePath)
        : stagedExecutable;
      const smokeExecutableStat = await NodeFSP.lstat(smokeExecutablePath).catch(() => undefined);
      if (!smokeExecutableStat?.isFile() || smokeExecutableStat.isSymbolicLink()) {
        throw new ManagedProviderRuntimeError(
          `Managed ${this.#displayName} payload did not contain the reviewed smoke-test executable.`,
        );
      }
      const smokeWorkingDirectory = artifact.smokeWorkingDirectory
        ? resolveManagedRuntimeArtifactPath(payloadPath, artifact.smokeWorkingDirectory)
        : undefined;
      if (smokeWorkingDirectory) {
        const smokeCwdStat = await NodeFSP.lstat(smokeWorkingDirectory).catch(() => undefined);
        if (!smokeCwdStat?.isDirectory() || smokeCwdStat.isSymbolicLink()) {
          throw new ManagedProviderRuntimeError(
            `Managed ${this.#displayName} payload did not contain the reviewed smoke-test directory.`,
          );
        }
      }
      await this.#dependencies.smoke(
        smokeExecutablePath,
        artifact.smokeArgs,
        this.#displayName,
        artifact.smokeEnvironment,
        { ...(smokeWorkingDirectory ? { cwd: smokeWorkingDirectory } : {}), signal },
      );
      if (signal.aborted) throw new DOMException("Installation cancelled.", "AbortError");
      onProgress?.({ stage: "activating" });
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
      const replaced = `${destination}.replaced-${this.#dependencies.now()}`;
      const hadExisting = await NodeFSP.access(destination).then(
        () => true,
        () => false,
      );
      const activationId = this.#dependencies.activationId();
      await this.#writeActivation({
        schemaVersion: 1,
        activationId,
        destinationRelativePath: NodePath.relative(this.#root, destination),
        replacedRelativePath: hadExisting ? NodePath.relative(this.#root, replaced) : null,
      });
      let existingMoved = false;
      let candidateMoved = false;
      try {
        if (hadExisting) {
          await NodeFSP.rename(destination, replaced);
          existingMoved = true;
        }
        await NodeFSP.rename(payloadPath, destination);
        candidateMoved = true;
        if (qualify) {
          await qualify({
            artifact,
            executablePath: this.launchPath(artifact),
            payloadPath: destination,
            signal,
          });
        }
        if (signal.aborted) throw new DOMException("Installation cancelled.", "AbortError");
        const previousVersion =
          previousState?.activeVersion && previousState.activeVersion !== artifact.version
            ? previousState.activeVersion
            : (previousState?.previousVersion ?? null);
        const previousArtifact =
          previousState?.activeVersion && previousState.activeVersion !== artifact.version
            ? previousState.schemaVersion === 3
              ? previousState.activeArtifact
              : null
            : previousState?.schemaVersion === 3
              ? previousState.previousArtifact
              : null;
        await this.#writeState({
          schemaVersion: 3,
          selection: "managed",
          activationId,
          targetKey: managedRuntimeTargetKey(artifact.target),
          activeVersion: artifact.version,
          previousVersion,
          executableRelativePath: NodePath.relative(this.#root, this.launchPath(artifact)),
          activeArtifact: managedRuntimeArtifactReceipt(artifact),
          previousArtifact,
        });
      } catch (cause) {
        try {
          if (candidateMoved) {
            await NodeFSP.rm(destination, { recursive: true, force: true });
          }
          if (existingMoved) await NodeFSP.rename(replaced, destination);
          await NodeFSP.rm(this.#activationPath, { force: true });
        } catch (rollbackCause) {
          throw new ManagedProviderRuntimeError(
            `Managed ${this.#displayName} activation failed and the previous runtime could not be restored.`,
            { cause: new AggregateError([cause, rollbackCause]) },
          );
        }
        throw cause;
      }
      await NodeFSP.rm(this.#activationPath, { force: true }).catch(() => undefined);
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

  async #writeActivation(activation: ManagedProviderRuntimeActivation): Promise<void> {
    await NodeFSP.mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporary = `${this.#activationPath}.${process.pid}.${this.#dependencies.now()}.tmp`;
    await NodeFSP.writeFile(temporary, `${JSON.stringify(activation, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await NodeFSP.rename(temporary, this.#activationPath);
  }

  async #reconcileActivation(): Promise<void> {
    const raw = await NodeFSP.readFile(this.#activationPath, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    const activation = (() => {
      try {
        return decodeActivation(JSON.parse(raw) as unknown);
      } catch {
        return undefined;
      }
    })();
    if (!activation) {
      await NodeFSP.rm(this.#activationPath, { force: true });
      return;
    }

    const destination = NodePath.resolve(this.#root, activation.destinationRelativePath);
    const replaced = activation.replacedRelativePath
      ? NodePath.resolve(this.#root, activation.replacedRelativePath)
      : null;
    const state = await this.readState();
    const committed = state?.schemaVersion === 3 && state.activationId === activation.activationId;
    if (committed) {
      if (replaced) await NodeFSP.rm(replaced, { recursive: true, force: true });
    } else if (replaced) {
      const replacedExists = await NodeFSP.access(replaced).then(
        () => true,
        () => false,
      );
      if (replacedExists) {
        await NodeFSP.rm(destination, { recursive: true, force: true });
        await NodeFSP.rename(replaced, destination);
      }
    } else {
      await NodeFSP.rm(destination, { recursive: true, force: true });
    }
    await NodeFSP.rm(this.#activationPath, { force: true });
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

    const state = await this.readState();
    const candidateWasCommitted =
      state?.schemaVersion === 3 &&
      state.targetKey === managedRuntimeTargetKey(artifact.target) &&
      state.activeArtifact.catalogRevision === artifact.catalogRevision;
    if (candidateWasCommitted) {
      await Promise.all(
        replacements.map((entry) =>
          NodeFSP.rm(NodePath.join(parent, entry), { recursive: true, force: true }),
        ),
      );
      return;
    }

    const [newest, ...older] = replacements;
    await NodeFSP.rm(destination, { recursive: true, force: true });
    if (newest) await NodeFSP.rename(NodePath.join(parent, newest), destination);
    await Promise.all(
      older.map((entry) =>
        NodeFSP.rm(NodePath.join(parent, entry), { recursive: true, force: true }),
      ),
    );
  }
}
