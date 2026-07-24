import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS, createReadStream } from "node:fs";
import FS from "node:fs/promises";
import Path from "node:path";

import {
  PROVIDER_DISPLAY_NAMES,
  ServerProviderInstallationState as ServerProviderInstallationStateSchema,
  type ProviderKind,
  ServerProviderInstallationError,
  type ServerProviderInstallationState,
  type ServerProviderRuntimeSource,
} from "@synara/contracts";
import { compareSemverVersions } from "@synara/shared/providerVersions";
import { mergePathEntries, readWindowsPersistentEnvironmentAsync } from "@synara/shared/shell";
import { Effect, Layer, PubSub, Schema, Stream } from "effect";

import { ServerConfig } from "../../config";
import { writeFileStringAtomically } from "../../atomicWrite";
import { runProcess } from "../../processRunner";
import {
  ProviderRuntimeManager,
  type ProviderRuntimeManagerShape,
  type ResolvedProviderRuntime,
} from "../Services/ProviderRuntimeManager";
import {
  downloadProviderRuntime,
  extractProviderRuntime,
  verifyProviderRuntimeDigest,
} from "../providerRuntimeFiles";
import {
  getProviderRuntimeRecipe,
  PROVIDER_RUNTIME_RECIPES,
  ProviderRuntimeRecipeError,
} from "../providerRuntimeRecipes";
import { detectProviderRuntimeTarget } from "../providerRuntimeTarget";
import {
  type ProviderRuntimeArtifact,
  type ProviderRuntimeCurrentRecord,
  type ProviderRuntimeSnapshot,
  providerRuntimeReleaseId,
  providerRuntimeTargetId,
} from "../providerRuntimeTypes";

export function canActivateManagedRuntimeVersion(input: {
  readonly currentVersion: string | null;
  readonly candidateVersion: string;
}): boolean {
  return (
    input.currentVersion === null ||
    compareSemverVersions(input.candidateVersion, input.currentVersion) >= 0
  );
}

function managedRuntimeDowngradeMessage(input: {
  readonly provider: ProviderKind;
  readonly currentVersion: string;
  readonly candidateVersion: string;
  readonly operation: "install" | "repair";
}): string | null {
  if (
    canActivateManagedRuntimeVersion({
      currentVersion: input.currentVersion,
      candidateVersion: input.candidateVersion,
    })
  ) {
    return null;
  }
  const action = input.operation === "repair" ? "repair" : "replace";
  return `Scient will not ${action} ${PROVIDER_DISPLAY_NAMES[input.provider]} ${input.currentVersion} with older version ${input.candidateVersion}.`;
}

const PROVIDERS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
];
const PLAN_TTL_MS = 10 * 60 * 1000;
const SMOKE_TIMEOUT_MS = 15_000;
const SMOKE_OUTPUT_LIMIT = 64 * 1024;
const MINIMUM_INSTALL_FREE_BYTES = 256 * 1024 * 1024;
const WINDOWS_ENVIRONMENT_CACHE_MS = 5_000;
const TERMINAL_INSTALLATION_STATUSES = new Set<ServerProviderInstallationState["status"]>([
  "installed",
  "succeeded",
  "failed",
  "cancelled",
]);
const RESTORABLE_INSTALLATION_STATUSES = new Set<ServerProviderInstallationState["status"]>([
  "failed",
  "cancelled",
]);

type RuntimeOperation = ServerProviderInstallationState["operation"];

interface PreparedInstall {
  readonly provider: ProviderKind;
  readonly artifact: ProviderRuntimeArtifact;
  readonly expiresAtMs: number;
}

interface ActiveOperation {
  readonly operationId: string;
  readonly operation: RuntimeOperation;
  readonly gate: ProviderRuntimeOperationGate;
  completion: Promise<void>;
}

export interface ProviderRuntimeOperationGate {
  readonly signal: AbortSignal;
  readonly cancel: () => boolean;
  readonly beginCommit: () => boolean;
}

export function makeProviderRuntimeOperationGate(): ProviderRuntimeOperationGate {
  const controller = new AbortController();
  let phase: "running" | "cancelled" | "committing" = "running";
  return {
    signal: controller.signal,
    cancel: () => {
      if (phase !== "running") return false;
      phase = "cancelled";
      controller.abort();
      return true;
    },
    beginCommit: () => {
      if (phase !== "running" || controller.signal.aborted) return false;
      phase = "committing";
      return true;
    },
  };
}

export async function cancelAndAwaitProviderRuntimeOperations(
  operations: ReadonlyArray<{
    readonly gate: ProviderRuntimeOperationGate;
    readonly completion: Promise<void>;
  }>,
): Promise<void> {
  for (const operation of operations) operation.gate.cancel();
  await Promise.allSettled(operations.map((operation) => operation.completion));
}

function installationError(input: {
  readonly provider: ProviderKind;
  readonly reason: ConstructorParameters<typeof ServerProviderInstallationError>[0]["reason"];
  readonly message: string;
}): ServerProviderInstallationError {
  return new ServerProviderInstallationError(input);
}

function runtimeRoot(stateDir: string): string {
  return Path.join(stateDir, "provider-runtimes");
}

function providerRoot(stateDir: string, provider: ProviderKind): string {
  return Path.join(runtimeRoot(stateDir), provider);
}

function currentRecordPath(stateDir: string, provider: ProviderKind): string {
  return Path.join(providerRoot(stateDir, provider), "current.json");
}

function installationStatePath(stateDir: string, provider: ProviderKind): string {
  return Path.join(stateDir, "provider-installations", `${provider}.json`);
}

const decodeInstallationState = Schema.decodeUnknownSync(ServerProviderInstallationStateSchema);

async function readPersistedInstallationState(
  stateDir: string,
  provider: ProviderKind,
): Promise<ServerProviderInstallationState | null> {
  try {
    const state = decodeInstallationState(
      JSON.parse(await FS.readFile(installationStatePath(stateDir, provider), "utf8")),
    );
    return RESTORABLE_INSTALLATION_STATUSES.has(state.status) ? state : null;
  } catch {
    return null;
  }
}

async function writePersistedInstallationState(
  stateDir: string,
  provider: ProviderKind,
  state: ServerProviderInstallationState,
): Promise<void> {
  await Effect.runPromise(
    writeFileStringAtomically({
      filePath: installationStatePath(stateDir, provider),
      contents: `${JSON.stringify(state, null, 2)}\n`,
    }),
  );
}

function releaseRoot(stateDir: string, provider: ProviderKind, releaseId: string): string {
  return Path.join(providerRoot(stateDir, provider), "releases", releaseId);
}

function isCurrentRecord(
  value: unknown,
  provider: ProviderKind,
): value is ProviderRuntimeCurrentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ProviderRuntimeCurrentRecord>;
  return (
    record.version === 1 &&
    record.provider === provider &&
    typeof record.releaseId === "string" &&
    (record.previousReleaseId === null || typeof record.previousReleaseId === "string") &&
    typeof record.runtimeVersion === "string" &&
    typeof record.executableRelativePath === "string" &&
    typeof record.executablePath === "string" &&
    Array.isArray(record.smokeArgs) &&
    record.smokeArgs.every((arg) => typeof arg === "string") &&
    (record.digestAlgorithm === "sha256" || record.digestAlgorithm === "sha512") &&
    typeof record.digest === "string" &&
    (record.executableDigest === undefined || typeof record.executableDigest === "string") &&
    typeof record.sourceUrl === "string" &&
    typeof record.catalogRevision === "string" &&
    typeof record.installedAt === "string"
  );
}

async function readCurrentRecord(
  stateDir: string,
  provider: ProviderKind,
): Promise<ProviderRuntimeCurrentRecord | null> {
  try {
    const value = JSON.parse(
      await FS.readFile(currentRecordPath(stateDir, provider), "utf8"),
    ) as unknown;
    if (!isCurrentRecord(value, provider)) return null;
    return (await isSafeRuntimeRecord(stateDir, provider, value)) ? value : null;
  } catch {
    return null;
  }
}

async function writeCurrentRecord(
  stateDir: string,
  provider: ProviderKind,
  record: ProviderRuntimeCurrentRecord,
): Promise<void> {
  await Effect.runPromise(
    writeFileStringAtomically({
      filePath: currentRecordPath(stateDir, provider),
      contents: `${JSON.stringify(record, null, 2)}\n`,
    }),
  );
}

function releaseRecordPath(stateDir: string, provider: ProviderKind, releaseId: string): string {
  return Path.join(releaseRoot(stateDir, provider, releaseId), "release.json");
}

async function readReleaseRecord(
  stateDir: string,
  provider: ProviderKind,
  releaseId: string,
): Promise<ProviderRuntimeCurrentRecord | null> {
  try {
    const value = JSON.parse(
      await FS.readFile(releaseRecordPath(stateDir, provider, releaseId), "utf8"),
    ) as unknown;
    return isCurrentRecord(value, provider) &&
      value.releaseId === releaseId &&
      (await isSafeRuntimeRecord(stateDir, provider, value))
      ? value
      : null;
  } catch {
    return null;
  }
}

async function isSafeRuntimeRecord(
  stateDir: string,
  provider: ProviderKind,
  record: ProviderRuntimeCurrentRecord,
): Promise<boolean> {
  const root = Path.resolve(releaseRoot(stateDir, provider, record.releaseId));
  const expected = Path.resolve(root, record.executableRelativePath);
  const recorded = Path.resolve(record.executablePath);
  const relative = Path.relative(root, expected);
  if (
    expected !== recorded ||
    relative === "" ||
    relative.startsWith(`..${Path.sep}`) ||
    relative === ".." ||
    Path.isAbsolute(relative)
  ) {
    return false;
  }
  const executableStat = await FS.lstat(recorded).catch(() => null);
  if (!executableStat?.isFile() || executableStat.isSymbolicLink()) return false;
  const [realRoot, realExecutable] = await Promise.all([
    FS.realpath(root).catch(() => null),
    FS.realpath(recorded).catch(() => null),
  ]);
  if (!realRoot || !realExecutable) return false;
  const realRelative = Path.relative(realRoot, realExecutable);
  return (
    realRelative !== "" &&
    realRelative !== ".." &&
    !realRelative.startsWith(`..${Path.sep}`) &&
    !Path.isAbsolute(realRelative)
  );
}

async function removeCurrentRecord(stateDir: string, provider: ProviderKind): Promise<void> {
  await FS.rm(currentRecordPath(stateDir, provider), { force: true });
}

export function findExecutableOnPath(input: {
  readonly command: string;
  readonly pathValue: string;
  readonly platform?: NodeJS.Platform;
}): Promise<string | null> {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? Path.win32 : Path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions =
    platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((part) => part.toLowerCase())
      : [""];
  return (async () => {
    for (const directory of input.pathValue.split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const hasExtension = pathApi.extname(input.command).length > 0;
        const candidate = pathApi.join(
          directory,
          hasExtension ? input.command : `${input.command}${extension}`,
        );
        const stat = await FS.stat(candidate).catch(() => null);
        if (!stat?.isFile()) continue;
        if (platform !== "win32") {
          try {
            await FS.access(candidate, FS_CONSTANTS.X_OK);
          } catch {
            continue;
          }
        }
        return FS.realpath(candidate).catch(() => candidate);
      }
    }
    return null;
  })();
}

export function windowsKnownProviderExecutableCandidates(input: {
  readonly provider: ProviderKind;
  readonly environment: NodeJS.ProcessEnv | Partial<Record<string, string>>;
}): ReadonlyArray<string> {
  if (input.provider !== "codex") return [];
  const localAppData = Object.entries(input.environment)
    .find(([name]) => name.toUpperCase() === "LOCALAPPDATA")?.[1]
    ?.trim();
  return localAppData
    ? [Path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe")]
    : [];
}

async function firstExistingFile(candidates: ReadonlyArray<string>): Promise<string | null> {
  for (const candidate of candidates) {
    const stat = await FS.stat(candidate).catch(() => null);
    if (stat?.isFile()) return FS.realpath(candidate).catch(() => candidate);
  }
  return null;
}

async function resolveConfiguredExecutable(input: {
  readonly command: string;
  readonly pathValue: string;
  readonly platform?: NodeJS.Platform;
}): Promise<string | null> {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? Path.win32 : Path.posix;
  const hasPathSeparator =
    pathApi.isAbsolute(input.command) ||
    input.command.includes(pathApi.sep) ||
    (platform === "win32" && input.command.includes("/"));
  if (!hasPathSeparator) {
    return findExecutableOnPath({ ...input, platform });
  }

  const stat = await FS.stat(input.command).catch(() => null);
  if (!stat?.isFile()) return null;
  if (platform !== "win32") {
    try {
      await FS.access(input.command, FS_CONSTANTS.X_OK);
    } catch {
      return null;
    }
  }
  return FS.realpath(input.command).catch(() => input.command);
}

async function smokeTestExecutable(input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly signal: AbortSignal;
}): Promise<void> {
  await runProcess(input.executable, input.args, {
    signal: input.signal,
    timeoutMs: SMOKE_TIMEOUT_MS,
    maxBufferBytes: SMOKE_OUTPUT_LIMIT,
    outputMode: "truncate",
  });
}

async function hashExecutable(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() ? cause.message.trim() : String(cause);
}

export const ProviderRuntimeManagerLive = Layer.effect(
  ProviderRuntimeManager,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const changes = yield* PubSub.unbounded<ReadonlyMap<ProviderKind, ProviderRuntimeSnapshot>>();
    const records = new Map<ProviderKind, ProviderRuntimeCurrentRecord>();
    const installationStates = new Map<ProviderKind, ServerProviderInstallationState>();
    const installationStateWrites = new Map<ProviderKind, Promise<void>>();
    const plans = new Map<string, PreparedInstall>();
    const active = new Map<ProviderKind, ActiveOperation>();
    const verifiedManagedReleases = new Set<string>();
    const managedVerificationPromises = new Map<string, Promise<void>>();
    const basePath = process.env.PATH ?? "";
    let windowsEnvironmentCache: Partial<Record<string, string>> | null = null;
    let windowsEnvironmentReadAt = 0;
    const managedDirectoriesAdded = new Set<string>();
    let lastAssignedPath = basePath;
    let disposed = false;

    for (const provider of PROVIDERS) {
      const persistedInstallationState = yield* Effect.promise(() =>
        readPersistedInstallationState(config.stateDir, provider),
      );
      if (persistedInstallationState) {
        installationStates.set(provider, persistedInstallationState);
      }
      const record = yield* Effect.promise(() => readCurrentRecord(config.stateDir, provider));
      if (record) {
        records.set(provider, record);
      } else {
        const currentRecordExists = yield* Effect.promise(() =>
          FS.stat(currentRecordPath(config.stateDir, provider))
            .then(() => true)
            .catch(() => false),
        );
        if (!currentRecordExists) {
          // A prior remove only deactivates the runtime immediately so an already-running
          // provider process is never invalidated. The next app start is the safe GC point.
          yield* Effect.promise(() =>
            FS.rm(providerRoot(config.stateDir, provider), {
              recursive: true,
              force: true,
            }).catch(() => undefined),
          );
        } else {
          yield* Effect.logWarning(
            `Preserving ${provider} managed runtime files because current.json is invalid.`,
          );
        }
      }
    }

    const currentSystemEnvironment = async (): Promise<Partial<Record<string, string>>> => {
      if (process.platform !== "win32") return process.env;
      if (
        windowsEnvironmentCache &&
        Date.now() - windowsEnvironmentReadAt < WINDOWS_ENVIRONMENT_CACHE_MS
      ) {
        return windowsEnvironmentCache;
      }
      try {
        windowsEnvironmentCache = await readWindowsPersistentEnvironmentAsync();
        windowsEnvironmentReadAt = Date.now();
      } catch {
        windowsEnvironmentCache = {};
        windowsEnvironmentReadAt = Date.now();
      }
      return windowsEnvironmentCache;
    };

    const currentSystemPath = async (): Promise<{
      readonly pathValue: string;
      readonly environment: Partial<Record<string, string>>;
    }> => {
      const environment = await currentSystemEnvironment();
      return {
        pathValue: mergePathEntries(environment.PATH, basePath, process.platform) ?? basePath,
        environment,
      };
    };

    const refreshProcessPath = () => {
      const managedDirectories = Array.from(records.values())
        .filter((record) => verifiedManagedReleases.has(`${record.provider}:${record.releaseId}`))
        .map((record) => Path.dirname(record.executablePath));
      for (const directory of managedDirectories) managedDirectoriesAdded.add(directory);
      const delimiter = process.platform === "win32" ? ";" : ":";
      lastAssignedPath = [basePath, ...new Set(managedDirectories)].filter(Boolean).join(delimiter);
      process.env.PATH = lastAssignedPath;
    };
    refreshProcessPath();

    const snapshotFor = (provider: ProviderKind): ProviderRuntimeSnapshot => {
      const recipe = getProviderRuntimeRecipe(provider);
      const record = records.get(provider);
      return {
        provider,
        managedExecutablePath: record?.executablePath ?? null,
        managedVersion: record?.runtimeVersion ?? null,
        previousReleaseAvailable: Boolean(record?.previousReleaseId),
        bundled: recipe.bundled === true,
        canInstall: recipe.bundled !== true,
        installationState: installationStates.get(provider) ?? null,
      };
    };

    const allSnapshots = () =>
      new Map(PROVIDERS.map((provider) => [provider, snapshotFor(provider)] as const));

    const publish = () => {
      if (!disposed) Effect.runFork(PubSub.publish(changes, allSnapshots()).pipe(Effect.asVoid));
    };

    const setInstallationState = (
      provider: ProviderKind,
      input: {
        readonly operationId: string;
        readonly operation: RuntimeOperation;
        readonly status: ServerProviderInstallationState["status"];
        readonly startedAt: string;
        readonly finishedAt?: string | null;
        readonly message: string;
        readonly version?: string | null;
        readonly bytesDownloaded?: number;
        readonly totalBytes?: number | null;
      },
    ) => {
      const state: ServerProviderInstallationState = {
        operationId: input.operationId,
        operation: input.operation,
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt ?? null,
        message: input.message,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.bytesDownloaded !== undefined
          ? { bytesDownloaded: Math.max(0, Math.trunc(input.bytesDownloaded)) }
          : {}),
        ...(input.totalBytes !== undefined
          ? {
              totalBytes:
                input.totalBytes === null ? null : Math.max(0, Math.trunc(input.totalBytes)),
            }
          : {}),
      };
      installationStates.set(provider, state);
      if (TERMINAL_INSTALLATION_STATUSES.has(state.status)) {
        const previousWrite = installationStateWrites.get(provider) ?? Promise.resolve();
        const nextWrite = previousWrite
          .catch(() => undefined)
          .then(() => writePersistedInstallationState(config.stateDir, provider, state))
          .catch((cause) =>
            Effect.runPromise(
              Effect.logWarning("Failed to persist provider installation diagnostics.", {
                provider,
                cause,
              }),
            ),
          );
        installationStateWrites.set(provider, nextWrite);
      }
      publish();
    };

    const verifyManagedRecord = async (
      provider: ProviderKind,
      record: ProviderRuntimeCurrentRecord,
    ): Promise<void> => {
      const verificationKey = `${provider}:${record.releaseId}`;
      if (verifiedManagedReleases.has(verificationKey)) return;
      const existing = managedVerificationPromises.get(verificationKey);
      if (existing) return existing;
      const verification = (async () => {
        const executableDigest = await hashExecutable(record.executablePath);
        if (record.executableDigest && record.executableDigest !== executableDigest) {
          throw new Error("Managed provider executable checksum changed after installation.");
        }
        await smokeTestExecutable({
          executable: record.executablePath,
          args: record.smokeArgs,
          signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
        });
        if (!record.executableDigest) {
          const upgraded = { ...record, executableDigest } satisfies ProviderRuntimeCurrentRecord;
          records.set(provider, upgraded);
          await writeCurrentRecord(config.stateDir, provider, upgraded);
          await writeFileStringAtomically({
            filePath: releaseRecordPath(config.stateDir, provider, record.releaseId),
            contents: `${JSON.stringify({ ...upgraded, previousReleaseId: null }, null, 2)}\n`,
          }).pipe(Effect.runPromise);
        }
        verifiedManagedReleases.add(verificationKey);
        refreshProcessPath();
      })().finally(() => managedVerificationPromises.delete(verificationKey));
      managedVerificationPromises.set(verificationKey, verification);
      return verification;
    };

    const startOperation = (input: {
      readonly provider: ProviderKind;
      readonly operation: RuntimeOperation;
      readonly operationId?: string;
      readonly run: (context: {
        readonly operationId: string;
        readonly startedAt: string;
        readonly gate: ProviderRuntimeOperationGate;
      }) => Promise<void>;
    }): Effect.Effect<void, ServerProviderInstallationError> =>
      Effect.gen(function* () {
        if (active.has(input.provider)) {
          return yield* installationError({
            provider: input.provider,
            reason: "already_running",
            message: "A provider runtime operation is already running.",
          });
        }
        const operationId = input.operationId ?? randomUUID();
        const startedAt = new Date().toISOString();
        const gate = makeProviderRuntimeOperationGate();
        const activeOperation: ActiveOperation = {
          operationId,
          operation: input.operation,
          gate,
          completion: Promise.resolve(),
        };
        active.set(input.provider, activeOperation);
        setInstallationState(input.provider, {
          operationId,
          operation: input.operation,
          status:
            input.operation === "install" || input.operation === "repair"
              ? "resolving"
              : "installing",
          startedAt,
          message:
            input.operation === "install"
              ? "Preparing the provider runtime."
              : input.operation === "repair"
                ? "Preparing a clean provider runtime repair."
                : input.operation === "rollback"
                  ? "Restoring the previous provider runtime."
                  : "Removing the Scient-managed provider runtime.",
        });

        const completion = Promise.resolve()
          .then(() => input.run({ operationId, startedAt, gate }))
          .catch((cause) => {
            const cancelled = gate.signal.aborted;
            const previousState = installationStates.get(input.provider);
            const failedFromStatus = previousState?.status;
            const failedAt =
              input.operation === "rollback"
                ? "restoring the previous provider"
                : input.operation === "remove"
                  ? "removing the managed provider"
                  : failedFromStatus === "resolving"
                    ? "resolving the trusted release"
                    : failedFromStatus === "downloading"
                      ? "downloading the provider"
                      : failedFromStatus === "verifying"
                        ? "verifying the download"
                        : failedFromStatus === "smoke_testing"
                          ? "checking the installed provider"
                          : "installing the provider";
            const operationLabel =
              input.operation === "repair"
                ? "Repair"
                : input.operation === "rollback"
                  ? "Rollback"
                  : input.operation === "remove"
                    ? "Removal"
                    : "Installation";
            setInstallationState(input.provider, {
              operationId,
              operation: input.operation,
              status: cancelled ? "cancelled" : "failed",
              startedAt,
              finishedAt: new Date().toISOString(),
              message: cancelled
                ? "Provider runtime operation was cancelled."
                : `${operationLabel} failed while ${failedAt}: ${errorMessage(cause)}`,
              ...(previousState?.version ? { version: previousState.version } : {}),
            });
          })
          .finally(() => {
            if (active.get(input.provider)?.operationId === operationId)
              active.delete(input.provider);
          });
        activeOperation.completion = completion;
      });

    const runInstall = async (input: {
      readonly provider: ProviderKind;
      readonly artifact: ProviderRuntimeArtifact;
      readonly operationId: string;
      readonly operation: "install" | "repair";
      readonly startedAt: string;
      readonly gate: ProviderRuntimeOperationGate;
    }): Promise<void> => {
      const { provider, artifact, operationId, operation, startedAt, gate } = input;
      const root = providerRoot(config.stateDir, provider);
      const downloads = Path.join(root, "downloads");
      await FS.mkdir(downloads, { recursive: true });
      const filesystem = await FS.statfs(downloads).catch(() => null);
      if (filesystem) {
        const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
        const requiredBytes = Math.max(
          MINIMUM_INSTALL_FREE_BYTES,
          (artifact.size ?? MINIMUM_INSTALL_FREE_BYTES) * 3,
        );
        if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
          throw new Error(
            `Not enough free disk space to install this provider safely. Free at least ${Math.ceil(requiredBytes / 1_048_576)} MB and try again.`,
          );
        }
      }
      const staging = await FS.mkdtemp(Path.join(downloads, `${operationId}-`));
      const archivePath = Path.join(staging, "download");
      let releaseId = `${providerRuntimeReleaseId(artifact)}${operation === "repair" ? `-repair-${Date.now()}` : ""}`;
      const stagedRelease = Path.join(staging, "release");
      let finalRelease = releaseRoot(config.stateDir, provider, releaseId);
      try {
        setInstallationState(provider, {
          operationId,
          operation,
          status: "downloading",
          startedAt,
          message: `Downloading ${provider} ${artifact.version}.`,
          version: artifact.version,
          totalBytes: artifact.size ?? null,
          bytesDownloaded: 0,
        });
        await downloadProviderRuntime({
          url: artifact.url,
          destination: archivePath,
          allowedHosts: artifact.allowedHosts,
          signal: gate.signal,
          ...(artifact.size ? { expectedSize: artifact.size } : {}),
          onProgress: (bytesDownloaded, totalBytes) =>
            setInstallationState(provider, {
              operationId,
              operation,
              status: "downloading",
              startedAt,
              message: `Downloading ${provider} ${artifact.version}.`,
              version: artifact.version,
              bytesDownloaded,
              totalBytes,
            }),
        });
        setInstallationState(provider, {
          operationId,
          operation,
          status: "verifying",
          startedAt,
          message: "Verifying the provider runtime.",
          version: artifact.version,
        });
        await verifyProviderRuntimeDigest({
          filePath: archivePath,
          algorithm: artifact.digestAlgorithm,
          expectedDigest: artifact.digest,
        });
        if (gate.signal.aborted) throw new DOMException("Installation cancelled.", "AbortError");

        setInstallationState(provider, {
          operationId,
          operation,
          status: "installing",
          startedAt,
          message: "Installing the verified provider runtime.",
          version: artifact.version,
        });
        const extractedExecutable = await extractProviderRuntime({
          archivePath,
          destination: stagedRelease,
          format: artifact.archiveFormat,
          executablePath: artifact.executablePath,
          signal: gate.signal,
        });
        const recipe = getProviderRuntimeRecipe(provider);
        const managedExecutableRelativePath = Path.join(
          "bin",
          `${recipe.executableName}${
            artifact.target.platform === "win32" && !recipe.executableName.endsWith(".exe")
              ? ".exe"
              : ""
          }`,
        );
        const executable = Path.join(stagedRelease, managedExecutableRelativePath);
        await FS.mkdir(Path.dirname(executable), { recursive: true });
        await FS.link(extractedExecutable, executable).catch(async () => {
          await FS.copyFile(extractedExecutable, executable, FS_CONSTANTS.COPYFILE_EXCL);
        });
        if (process.platform !== "win32") await FS.chmod(executable, 0o700);
        setInstallationState(provider, {
          operationId,
          operation,
          status: "smoke_testing",
          startedAt,
          message: "Checking that the provider runtime starts correctly.",
          version: artifact.version,
        });
        await smokeTestExecutable({
          executable,
          args: artifact.smokeArgs,
          signal: gate.signal,
        });

        const current = records.get(provider) ?? null;
        const downgradeMessage = current
          ? managedRuntimeDowngradeMessage({
              provider,
              currentVersion: current.runtimeVersion,
              candidateVersion: artifact.version,
              operation,
            })
          : null;
        if (downgradeMessage) throw new Error(downgradeMessage);

        await FS.mkdir(Path.dirname(finalRelease), { recursive: true });
        const existingFinal = await FS.stat(finalRelease).catch(() => null);
        if (existingFinal) {
          releaseId = `${releaseId}-${operationId.slice(0, 8)}`;
          finalRelease = releaseRoot(config.stateDir, provider, releaseId);
        }
        await FS.rename(stagedRelease, finalRelease);
        const finalExecutable = Path.join(finalRelease, managedExecutableRelativePath);
        const record: ProviderRuntimeCurrentRecord = {
          version: 1,
          provider,
          releaseId,
          previousReleaseId:
            current && current.releaseId !== releaseId
              ? current.releaseId
              : (current?.previousReleaseId ?? null),
          runtimeVersion: artifact.version,
          executableRelativePath: managedExecutableRelativePath,
          executablePath: finalExecutable,
          smokeArgs: artifact.smokeArgs,
          digestAlgorithm: artifact.digestAlgorithm,
          digest: artifact.digest,
          executableDigest: await hashExecutable(finalExecutable),
          sourceUrl: artifact.url,
          catalogRevision: artifact.catalogRevision,
          installedAt: new Date().toISOString(),
        };
        if (gate.signal.aborted) throw new DOMException("Installation cancelled.", "AbortError");
        await writeFileStringAtomically({
          filePath: releaseRecordPath(config.stateDir, provider, releaseId),
          contents: `${JSON.stringify({ ...record, previousReleaseId: null }, null, 2)}\n`,
        }).pipe(Effect.runPromise);
        if (!gate.beginCommit()) throw new DOMException("Installation cancelled.", "AbortError");
        await writeCurrentRecord(config.stateDir, provider, record);
        records.set(provider, record);
        verifiedManagedReleases.add(`${provider}:${record.releaseId}`);
        refreshProcessPath();
        setInstallationState(provider, {
          operationId,
          operation,
          status: "installed",
          startedAt,
          finishedAt: new Date().toISOString(),
          message: `${provider} ${artifact.version} is installed and verified.`,
          version: artifact.version,
        });
      } finally {
        await FS.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    const prepareInstall: ProviderRuntimeManagerShape["prepareInstall"] = (provider) =>
      Effect.tryPromise({
        try: async () => {
          const recipe = getProviderRuntimeRecipe(provider);
          if (recipe.bundled) {
            throw installationError({
              provider,
              reason: "unsupported_provider",
              message: "This provider is built into Scient and does not need installation.",
            });
          }
          const target = await detectProviderRuntimeTarget();
          const artifact = await recipe.resolve(target, AbortSignal.timeout(30_000));
          const planToken = randomUUID();
          const expiresAtMs = Date.now() + PLAN_TTL_MS;
          plans.set(planToken, { provider, artifact, expiresAtMs });
          for (const [token, plan] of plans) {
            if (plan.expiresAtMs <= Date.now()) plans.delete(token);
          }
          return {
            provider,
            planToken,
            version: artifact.version,
            target: providerRuntimeTargetId(target),
            sourceHost: new URL(artifact.url).hostname,
            downloadBytes: artifact.size ?? null,
            expiresAt: new Date(expiresAtMs).toISOString(),
          };
        },
        catch: (cause) =>
          cause instanceof ServerProviderInstallationError
            ? cause
            : installationError({
                provider,
                reason:
                  cause instanceof ProviderRuntimeRecipeError
                    ? cause.message.toLowerCase().includes("newer")
                      ? "managed_runtime_unavailable"
                      : "unsupported_target"
                    : "download_failed",
                message: errorMessage(cause),
              }),
      });

    const install: ProviderRuntimeManagerShape["install"] = (input) =>
      Effect.gen(function* () {
        const plan = plans.get(input.planToken);
        if (!plan || plan.provider !== input.provider || plan.expiresAtMs <= Date.now()) {
          plans.delete(input.planToken);
          return yield* installationError({
            provider: input.provider,
            reason: "operation_not_found",
            message: "The installation plan expired. Review the provider download again.",
          });
        }
        const current = records.get(input.provider);
        const downgradeMessage = current
          ? managedRuntimeDowngradeMessage({
              provider: input.provider,
              currentVersion: current.runtimeVersion,
              candidateVersion: plan.artifact.version,
              operation: "install",
            })
          : null;
        if (downgradeMessage) {
          plans.delete(input.planToken);
          return yield* installationError({
            provider: input.provider,
            reason: "managed_runtime_unavailable",
            message: downgradeMessage,
          });
        }
        plans.delete(input.planToken);
        yield* startOperation({
          provider: input.provider,
          operation: "install",
          operationId: input.planToken,
          run: ({ operationId, startedAt, gate }) =>
            runInstall({
              provider: input.provider,
              artifact: plan.artifact,
              operationId,
              operation: "install",
              startedAt,
              gate,
            }),
        });
      });

    const cancel: ProviderRuntimeManagerShape["cancel"] = (input) =>
      Effect.gen(function* () {
        const operation = active.get(input.provider);
        if (!operation || operation.operationId !== input.operationId) {
          return yield* installationError({
            provider: input.provider,
            reason: "operation_not_found",
            message: "This provider runtime operation is no longer running.",
          });
        }
        if (!operation.gate.cancel()) {
          return yield* installationError({
            provider: input.provider,
            reason: "operation_not_found",
            message: "This provider runtime operation is already finishing.",
          });
        }
      });

    const repair: ProviderRuntimeManagerShape["repair"] = (input) =>
      Effect.gen(function* () {
        const current = records.get(input.provider);
        if (!current) {
          return yield* installationError({
            provider: input.provider,
            reason: "managed_runtime_unavailable",
            message: "There is no Scient-managed runtime to repair.",
          });
        }
        const artifact = yield* Effect.tryPromise({
          try: async () => {
            const target = await detectProviderRuntimeTarget();
            return getProviderRuntimeRecipe(input.provider).resolve(
              target,
              AbortSignal.timeout(30_000),
            );
          },
          catch: (cause) =>
            installationError({
              provider: input.provider,
              reason: "download_failed",
              message: errorMessage(cause),
            }),
        });
        const downgradeMessage = managedRuntimeDowngradeMessage({
          provider: input.provider,
          currentVersion: current.runtimeVersion,
          candidateVersion: artifact.version,
          operation: "repair",
        });
        if (downgradeMessage) {
          return yield* installationError({
            provider: input.provider,
            reason: "managed_runtime_unavailable",
            message: downgradeMessage,
          });
        }
        yield* startOperation({
          provider: input.provider,
          operation: "repair",
          run: ({ operationId, startedAt, gate }) =>
            runInstall({
              provider: input.provider,
              artifact,
              operationId,
              operation: "repair",
              startedAt,
              gate,
            }),
        });
      });

    const rollback: ProviderRuntimeManagerShape["rollback"] = (input) =>
      Effect.gen(function* () {
        const current = records.get(input.provider);
        if (!current?.previousReleaseId) {
          return yield* installationError({
            provider: input.provider,
            reason: "rollback_unavailable",
            message: "There is no previous Scient-managed runtime to restore.",
          });
        }
        yield* startOperation({
          provider: input.provider,
          operation: "rollback",
          run: async ({ operationId, startedAt, gate }) => {
            const previousMetadata = await readReleaseRecord(
              config.stateDir,
              input.provider,
              current.previousReleaseId!,
            );
            if (!previousMetadata)
              throw new Error("The previous provider runtime metadata is unavailable.");
            const previousExecutable = previousMetadata.executablePath;
            const stat = await FS.stat(previousExecutable).catch(() => null);
            if (!stat?.isFile())
              throw new Error("The previous provider runtime is no longer available.");
            await smokeTestExecutable({
              executable: previousExecutable,
              args: previousMetadata.smokeArgs,
              signal: gate.signal,
            });
            const previousRecord: ProviderRuntimeCurrentRecord = {
              ...previousMetadata,
              releaseId: current.previousReleaseId!,
              previousReleaseId: current.releaseId,
              executableDigest: await hashExecutable(previousExecutable),
              installedAt: new Date().toISOString(),
            };
            if (!gate.beginCommit()) throw new DOMException("Rollback cancelled.", "AbortError");
            await writeCurrentRecord(config.stateDir, input.provider, previousRecord);
            records.set(input.provider, previousRecord);
            verifiedManagedReleases.add(`${input.provider}:${previousRecord.releaseId}`);
            refreshProcessPath();
            setInstallationState(input.provider, {
              operationId,
              operation: "rollback",
              status: "succeeded",
              startedAt,
              finishedAt: new Date().toISOString(),
              message: "The previous provider runtime was restored.",
            });
          },
        });
      });

    const remove: ProviderRuntimeManagerShape["remove"] = (input) =>
      Effect.gen(function* () {
        if (!records.has(input.provider)) {
          return yield* installationError({
            provider: input.provider,
            reason: "managed_runtime_unavailable",
            message: "There is no Scient-managed runtime to remove.",
          });
        }
        yield* startOperation({
          provider: input.provider,
          operation: "remove",
          run: async ({ operationId, startedAt, gate }) => {
            if (!gate.beginCommit()) throw new DOMException("Removal cancelled.", "AbortError");
            await removeCurrentRecord(config.stateDir, input.provider);
            records.delete(input.provider);
            for (const key of verifiedManagedReleases) {
              if (key.startsWith(`${input.provider}:`)) verifiedManagedReleases.delete(key);
            }
            refreshProcessPath();
            setInstallationState(input.provider, {
              operationId,
              operation: "remove",
              status: "succeeded",
              startedAt,
              finishedAt: new Date().toISOString(),
              message:
                "The Scient-managed provider runtime was deactivated. Its files will be cleaned up after Scient restarts.",
            });
          },
        });
      });

    const getSnapshot: ProviderRuntimeManagerShape["getSnapshot"] = (provider) =>
      Effect.sync(() => snapshotFor(provider));

    const resolve: ProviderRuntimeManagerShape["resolve"] = (provider, configuredExecutable) =>
      Effect.promise(async (): Promise<ResolvedProviderRuntime> => {
        const recipe = getProviderRuntimeRecipe(provider);
        const configured = configuredExecutable?.trim() ?? "";
        const explicitCustom = configured.length > 0 && configured !== recipe.executableName;
        const record = records.get(provider) ?? null;
        const systemSearch = await currentSystemPath();
        const pathExecutable = explicitCustom
          ? await resolveConfiguredExecutable({
              command: configured,
              pathValue: systemSearch.pathValue,
            })
          : await findExecutableOnPath({
              command: recipe.executableName,
              pathValue: systemSearch.pathValue,
            });
        const knownExecutable =
          !explicitCustom && process.platform === "win32"
            ? await firstExistingFile(
                windowsKnownProviderExecutableCandidates({
                  provider,
                  environment: { ...process.env, ...systemSearch.environment },
                }),
              )
            : null;
        const systemExecutable = pathExecutable ?? knownExecutable;
        const source: ServerProviderRuntimeSource = explicitCustom
          ? "custom"
          : systemExecutable
            ? "system"
            : record
              ? "managed"
              : recipe.bundled
                ? "bundled"
                : "missing";
        if (source === "managed" && record) {
          try {
            await verifyManagedRecord(provider, record);
          } catch (cause) {
            const now = new Date().toISOString();
            setInstallationState(provider, {
              operationId: `verify-${record.releaseId}`,
              operation: "repair",
              status: "failed",
              startedAt: now,
              finishedAt: now,
              message: `The managed provider runtime is damaged and must be repaired. ${errorMessage(cause)}`,
              version: record.runtimeVersion,
            });
            return {
              source: "missing",
              executable: null,
              managedVersion: record.runtimeVersion,
              canInstall: false,
              canRepair: true,
              canRollback: Boolean(record.previousReleaseId),
              canRemove: true,
              message: "The Scient-managed runtime failed integrity verification.",
            };
          }
        }
        return {
          source,
          executable:
            source === "custom" || source === "system"
              ? systemExecutable
              : source === "managed"
                ? (record?.executablePath ?? null)
                : null,
          managedVersion: record?.runtimeVersion ?? null,
          canInstall: !recipe.bundled && source === "missing",
          canRepair: Boolean(record),
          canRollback: Boolean(record?.previousReleaseId),
          canRemove: Boolean(record),
          message:
            source === "bundled"
              ? "Built into Scient."
              : source === "custom" && !systemExecutable
                ? `The configured executable '${configured}' is unavailable or not executable. Change or reset this custom path in provider settings.`
                : source === "missing"
                  ? "No usable provider runtime was found."
                  : null,
        };
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        disposed = true;
        const activeOperations = [...active.values()];
        yield* Effect.promise(() => cancelAndAwaitProviderRuntimeOperations(activeOperations));
        active.clear();
        const currentPath = process.env.PATH ?? "";
        const delimiter = process.platform === "win32" ? ";" : ":";
        process.env.PATH =
          currentPath === lastAssignedPath
            ? basePath
            : currentPath
                .split(delimiter)
                .filter((directory) => !managedDirectoriesAdded.has(directory))
                .join(delimiter);
        yield* Effect.promise(() =>
          Promise.allSettled(installationStateWrites.values()).then(() => undefined),
        );
      }),
    );

    publish();
    return {
      prepareInstall,
      install,
      cancel,
      repair,
      rollback,
      remove,
      getSnapshot,
      resolve,
      streamChanges: Stream.fromPubSub(changes),
    } satisfies ProviderRuntimeManagerShape;
  }),
);

export const ProviderRuntimeRecipes = PROVIDER_RUNTIME_RECIPES;
