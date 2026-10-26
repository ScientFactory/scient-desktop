// @effect-diagnostics nodeBuiltinImport:off
/** Host-owned namespace adapter. Policy, records and recovery stay in the mutation service. */
import { validatePublicationArtifact } from "@t3tools/shared/scientPublicationArtifact";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String });
const Entry = Schema.Struct({
  ...Identity.fields,
  type: Schema.Literals(["file", "directory", "symlink", "reparse", "other"]),
});
const Containment = Schema.Literals([
  "bound-object",
  "macos-current-path-write-policy",
  "linux-landlock-root-object",
  "windows-pinned-ancestors",
]);
const Result = Schema.Struct({
  version: Schema.Literal(1),
  outcome: Schema.Literals(["unchanged", "applied", "unknown"]),
  code: Schema.Number,
  codeDomain: Schema.Literals(["errno", "win32"]),
  containment: Containment,
  binding: Schema.Struct({
    root: Schema.NullOr(Entry),
    parent: Schema.NullOr(Entry),
    record: Schema.NullOr(Entry),
  }),
  /** An observation before the syscall, not a conditional namespace guard. */
  sourceBefore: Schema.NullOr(Entry),
  /** Observations after the syscall. Exposed names may already have been replaced again. */
  sourceAfter: Schema.NullOr(Entry),
  destinationAfter: Schema.NullOr(Entry),
  /** 0 = completed; -1 = not attempted/not applicable; positive = native error. */
  flush: Schema.Struct({
    sourceFile: Schema.Number,
    destinationFile: Schema.Number,
    sourceDirectory: Schema.Number,
    destinationDirectory: Schema.Number,
  }),
});
const Capabilities = Schema.Struct({
  version: Schema.Literal(1),
  strictCurrentRoot: Schema.Boolean,
  folderObjectAuthority: Schema.optionalKey(Schema.Boolean),
  containment: Containment,
  windowsMoveInstall: Schema.optionalKey(Schema.Boolean),
  atomicExchange: Schema.Boolean,
  atomicPublicationMetadata: Schema.Boolean,
  atomicCreateMetadata: Schema.Boolean,
  exclusiveMove: Schema.Boolean,
  exclusiveLink: Schema.Boolean,
  publicationLease: Schema.Boolean,
  sharedPublicationLease: Schema.Boolean,
  privateRetentionDirectory: Schema.Boolean,
  sourceParentMkdir: Schema.Boolean,
  codeDomain: Schema.Literals(["errno", "win32"]),
});

const decodeCapabilities = Schema.decodeSync(Schema.fromJsonString(Capabilities));

export type NativeFileIdentity = typeof Identity.Type;
export type NativeFilePublicationResult = typeof Result.Type;
export type NativeFilePublicationCapabilities = typeof Capabilities.Type;
export type NativeFileAuthority = "strict-current-root" | "linux-held-root" | "bound-object";
const nativeFileAuthority = (): NativeFileAuthority =>
  HostProcess.Platform.defaultValue() === "linux" ? "linux-held-root" : "strict-current-root";
export const hasNativeFileAuthority = (capabilities: NativeFilePublicationCapabilities) =>
  capabilities.strictCurrentRoot ||
  (HostProcess.Platform.defaultValue() === "linux" &&
    capabilities.folderObjectAuthority === true &&
    capabilities.containment === "linux-landlock-root-object");
export interface NativeFileBinding {
  readonly rootPath: string;
  readonly parentRelativePath: string;
  /** Private host-owned same-volume directory; never supplied by a transport. */
  readonly recordPath: string;
  readonly rootIdentity: NativeFileIdentity;
  readonly parentIdentity: NativeFileIdentity;
  readonly recordIdentity: NativeFileIdentity;
}
export interface NativeFilePublicationRequest {
  readonly binding: NativeFileBinding;
  /** create clones a complete private stage into a distinct exclusive public inode; source remains private.
   * capture: parent -> record; all others: record -> parent. restore/move never overwrite. */
  readonly operation:
    | "capture"
    | "exchange"
    | "create"
    | "stage-create"
    | "staged-create"
    | "move"
    | "link"
    | "restore"
    | "metadata"
    | "mkdir"
    | "rmdir"
    | "win-prepare"
    | "win-prepare-create"
    | "win-prepare-delete"
    | "win-resume"
    | "win-resume-stage"
    | "win-resume-captured"
    | "win-restrict"
    | "win-capture"
    | "win-remove-captured"
    | "win-return-captured"
    | "win-install"
    | "win-restore-policy"
    | "win-release";
  readonly sourceName: string;
  readonly destinationName: string;
  /** bound-object is for qualification only and does not satisfy normal-save authority. */
  readonly authority?: NativeFileAuthority;
}
class NativeFilePublicationError extends Error {
  readonly result: NativeFilePublicationResult | null;
  constructor(message: string, result: NativeFilePublicationResult | null) {
    super(message);
    this.name = "NativeFilePublicationError";
    this.result = result;
  }
}

/** Explicit host configuration never falls through to a different executable. */
export async function resolveNativeFilePublicationHelperPath(
  configuredPath?: string,
): Promise<string | undefined> {
  const platform = HostProcess.Platform.defaultValue();
  const binary = platform === "win32" ? "scient-file-publication.exe" : "scient-file-publication";
  const moduleDirectory = NodeSea.isSea()
    ? NodePath.dirname(process.execPath)
    : NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  // Source development has a separate, explicit build location. Installed servers
  // only inspect their own resources; cwd, PATH and project files grant no authority.
  const source = moduleDirectory.endsWith(NodePath.join("src", "scient", "workspace"));
  const desktop = ["app.asar", "server.asar"].some((archive) =>
    moduleDirectory.endsWith(NodePath.join("resources", archive, "apps/server/dist")),
  );
  const candidate =
    configuredPath ??
    (desktop
      ? NodePath.resolve(moduleDirectory, "../../../../file-exchange", binary)
      : (HostProcess.Environment.defaultValue().SCIENT_FILE_PUBLICATION_HELPER ??
        (source
          ? NodePath.resolve(moduleDirectory, "../../../dist/file-exchange", binary)
          : NodePath.join(moduleDirectory, "file-exchange", binary))));
  try {
    await validatePublicationArtifact(candidate);
    await nativeFilePublicationCapabilities(candidate);
    return candidate;
  } catch {
    // Explicit configuration never falls through to another helper.
    return undefined;
  }
}
/** An invalid/lost reply has an unknown namespace outcome; it is never fallback permission. */
async function invoke(helperPath: string, args: ReadonlyArray<string>): Promise<string> {
  if (!NodePath.isAbsolute(helperPath))
    throw new NativeFilePublicationError(
      "Native helper path must be host-owned and absolute.",
      null,
    );
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = NodeChildProcess.spawn(helperPath, args, {
    // Capability inquiries cannot mutate files, so a wrong protocol may be terminated.
    ...(args[1] === "capabilities" ? { timeout: 10_000 } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "",
    overflow = false;
  let spawnError: Error | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length + chunk.length > 65536) overflow = true;
    else stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  // No abort/timeout race: even an abandoned waiter leaves this owner awaiting real retirement.
  child.on("close", (code, signal) => {
    if (spawnError || code !== 0 || signal !== null || overflow) {
      reject(
        new NativeFilePublicationError(
          `Native publication reply unknown: ${spawnError?.message ?? `exit=${code}, signal=${signal}, stderr=${stderr}`}`,
          null,
        ),
      );
    } else resolve(stdout);
  });
  return promise;
}
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(Result));
function parseResult(value: string): NativeFilePublicationResult {
  try {
    return decodeResult(value);
  } catch {
    throw new NativeFilePublicationError(
      "Invalid native publication reply; namespace outcome unknown.",
      null,
    );
  }
}
/** Helper replies already given, keyed by helper identity and the root's canonical
 * path/volume; `atomicCreateMetadata` alone describes the root's volume. A
 * replaced helper, linked root, or new volume asks the helper again. */
const knownCapabilities = new Map<string, typeof Capabilities.Type>();
const capabilitiesKey = async (helperPath: string, rootPath: string | undefined) => {
  try {
    const helper = await NodeFSP.stat(helperPath, { bigint: true });
    let volume = "";
    if (rootPath !== undefined) {
      if ((await NodeFSP.realpath(rootPath)) !== rootPath) return null;
      const root = await NodeFSP.lstat(rootPath, { bigint: true });
      if (!root.isDirectory()) return null;
      volume = String(root.dev);
    }
    return [
      helperPath,
      `${helper.dev}:${helper.ino}:${helper.size}:${helper.ctimeNs}:${helper.mtimeNs}`,
      rootPath ?? "",
      volume,
    ].join("\0");
  } catch {
    return null;
  }
};

/** A generic inquiry deliberately cannot authorize creation on an unspecified volume. */
export async function nativeFilePublicationCapabilities(helperPath: string, rootPath?: string) {
  if (rootPath !== undefined && (!NodePath.isAbsolute(rootPath) || rootPath.includes("\0")))
    throw new NativeFilePublicationError("Native capability root must be an absolute path.", null);
  const key = await capabilitiesKey(helperPath, rootPath);
  const known = key === null ? undefined : knownCapabilities.get(key);
  if (known !== undefined) return known;
  const reply = await invoke(helperPath, [
    "--protocol=1",
    "capabilities",
    ...(rootPath === undefined ? [] : [rootPath]),
  ]);
  let capabilities;
  try {
    capabilities = decodeCapabilities(reply);
  } catch {
    throw new NativeFilePublicationError("Invalid native publication capability reply.", null);
  }
  if (key !== null) knownCapabilities.set(key, capabilities);
  return capabilities;
}
function validatePaths(
  paths: Pick<NativeFileBinding, "rootPath" | "parentRelativePath" | "recordPath">,
) {
  if (!NodePath.isAbsolute(paths.rootPath) || !NodePath.isAbsolute(paths.recordPath))
    throw new NativeFilePublicationError("Native roots must be canonical absolute paths.", null);
  const components = paths.parentRelativePath.split(
    HostProcess.Platform.defaultValue() === "win32" ? /[\\/]/u : "/",
  );
  if (NodePath.isAbsolute(paths.parentRelativePath) || components.some((part) => part === ".."))
    throw new NativeFilePublicationError(
      "Parent must be a canonical root-relative directory.",
      null,
    );
  if (
    [paths.rootPath, paths.parentRelativePath, paths.recordPath].some((path) => path.includes("\0"))
  )
    throw new NativeFilePublicationError("Invalid native binding path.", null);
}
export async function bindNativeFilePublication(
  helperPath: string,
  paths: Pick<NativeFileBinding, "rootPath" | "parentRelativePath" | "recordPath">,
  authority: NativeFileAuthority = nativeFileAuthority(),
): Promise<NativeFileBinding> {
  validatePaths(paths);
  const result = parseResult(
    await invoke(helperPath, [
      "--protocol=1",
      "bind",
      authority,
      paths.rootPath,
      paths.parentRelativePath || ".",
      paths.recordPath,
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
    ]),
  );
  if (result.code !== 0 || !result.binding.root || !result.binding.parent || !result.binding.record)
    throw new NativeFilePublicationError(
      `Native binding refused (${result.codeDomain}:${result.code}).`,
      result,
    );
  const identity = (entry: NativeFileIdentity): NativeFileIdentity => ({
    dev: entry.dev,
    ino: entry.ino,
  });
  return {
    ...paths,
    rootIdentity: identity(result.binding.root),
    parentIdentity: identity(result.binding.parent),
    recordIdentity: identity(result.binding.record),
  };
}

export type NativeFileLeaseBinding = Pick<
  NativeFileBinding,
  "rootPath" | "parentRelativePath" | "rootIdentity" | "parentIdentity"
> & { readonly mode?: "shared" | "exclusive" };

/** Read-only physical identity binding; viewing/locking never provisions retention. */
export async function bindNativeFilePublicationParent(
  helperPath: string,
  rootPath: string,
  parentRelativePath: string,
): Promise<Omit<NativeFileLeaseBinding, "mode">> {
  validatePaths({ rootPath, parentRelativePath, recordPath: rootPath });
  const result = parseResult(
    await invoke(helperPath, [
      "--directory=1",
      "bind",
      nativeFileAuthority(),
      rootPath,
      parentRelativePath || ".",
      "-",
      "-",
      "-",
      "-",
      "-",
    ]),
  );
  if (result.code !== 0 || !result.binding.root || !result.binding.parent)
    throw new NativeFilePublicationError(
      `Native parent binding refused (${result.codeDomain}:${result.code}).`,
      result,
    );
  return {
    rootPath,
    parentRelativePath,
    rootIdentity: { dev: result.binding.root.dev, ino: result.binding.root.ino },
    parentIdentity: { dev: result.binding.parent.dev, ino: result.binding.parent.ino },
  };
}

export interface NativeFileDirectoryRequest {
  readonly binding: NativeFileLeaseBinding;
  readonly operation: "private-create" | "private-check" | "mkdir";
  readonly name: string;
}

function directoryArguments({ binding, operation, name }: NativeFileDirectoryRequest) {
  validatePaths({ ...binding, recordPath: binding.rootPath });
  const separators = HostProcess.Platform.defaultValue() === "win32" ? /[\\/:\0]/u : /[/\0]/u;
  if (!name || name === "." || name === ".." || separators.test(name))
    throw new NativeFilePublicationError("Native directory names must be single components.", null);
  return [
    "--directory=1",
    operation,
    nativeFileAuthority(),
    binding.rootPath,
    binding.parentRelativePath || ".",
    binding.rootIdentity.dev,
    binding.rootIdentity.ino,
    binding.parentIdentity.dev,
    binding.parentIdentity.ino,
    name,
  ];
}

/** A directory's lease binding observed in-process (POSIX only): canonical path,
 * device and inode of a real directory. Taking the lease re-binds natively and
 * refuses any differing identity, so no check is saved; anything unusual or
 * Windows asks the helper. */
export async function observedDirectoryBinding(
  helperPath: string,
  directory: string,
): Promise<Omit<NativeFileLeaseBinding, "mode">> {
  if (HostProcess.Platform.defaultValue() !== "win32" && NodePath.isAbsolute(directory)) {
    const observed = await NodeFSP.realpath(directory).then(
      async (canonical) => {
        if (canonical !== directory) return null;
        const stat = await NodeFSP.lstat(directory, { bigint: true });
        return stat.isDirectory() && !stat.isSymbolicLink()
          ? { dev: String(stat.dev), ino: String(stat.ino) }
          : null;
      },
      () => null,
    );
    if (observed !== null)
      return {
        rootPath: directory,
        parentRelativePath: "",
        rootIdentity: observed,
        parentIdentity: observed,
      };
  }
  return bindNativeFilePublicationParent(helperPath, directory, "");
}

/** Private retention folders the helper found private, keyed by ctime/device/inode
 * before it looked. Only the helper can read ACLs, so mode bits alone never
 * suffice; any owner/mode/ACL change moves ctime and forces a re-check. */
const validatedPrivate = new Map<string, string>();
const privateKey = async (directory: string) => {
  try {
    if ((await NodeFSP.realpath(directory)) !== directory) return null;
    const stat = await NodeFSP.lstat(directory, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}`
      : null;
  } catch {
    return null;
  }
};

/**
 * A POSIX directory the helper already found private in this process, still
 * unchanged at its canonical path: there is nothing to provision. Anything else
 * (first seen, changed since, missing, another spelling, Windows) goes through
 * the helper as always.
 */
async function alreadyPrivate(directory: string) {
  if (HostProcess.Platform.defaultValue() === "win32") return false;
  const known = validatedPrivate.get(directory);
  return known !== undefined && known === (await privateKey(directory));
}

/** Existing directory permissions are never repaired. Only newly missing host directories are made private. */
export function ensureNativePrivateRetentionDirectory(helperPath: string, absolutePath: string) {
  return nativePrivateRetentionDirectory(helperPath, absolutePath, true);
}
/** Validate a recorded folder without ever authorizing its creation. */
export function checkNativePrivateRetentionDirectory(helperPath: string, absolutePath: string) {
  return nativePrivateRetentionDirectory(helperPath, absolutePath, false);
}
async function nativePrivateRetentionDirectory(
  helperPath: string,
  absolutePath: string,
  create: boolean,
): Promise<string> {
  if (!NodePath.isAbsolute(absolutePath) || absolutePath.includes("\0"))
    throw new NativeFilePublicationError(
      "Retention directory must be an absolute host-owned path.",
      null,
    );
  const destination = NodePath.normalize(absolutePath);
  const parent = NodePath.dirname(destination);
  if (parent === destination)
    throw new NativeFilePublicationError(
      "A volume root cannot be a private retention directory.",
      null,
    );
  if (await alreadyPrivate(destination)) return destination;
  // Taken before the helper looks: a change after it moves the change time past this.
  const before = await privateKey(destination);
  let canonicalParent: string;
  try {
    canonicalParent = await NodeFSP.realpath(parent);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (!create) throw error;
    canonicalParent = await ensureNativePrivateRetentionDirectory(helperPath, parent);
  }
  const binding = await observedDirectoryBinding(helperPath, canonicalParent);
  const bindings: NativeFileLeaseBinding[] = [{ ...binding, mode: "exclusive" }];
  let ancestor = canonicalParent;
  for (;;) {
    const next = NodePath.dirname(ancestor);
    if (next === ancestor) break;
    const ancestorBinding = await observedDirectoryBinding(helperPath, next);
    if (ancestorBinding.parentIdentity.dev !== binding.parentIdentity.dev) break;
    bindings.push({ ...ancestorBinding, mode: "shared" });
    ancestor = next;
  }
  const result = await withNativeFilePublicationLease(
    helperPath,
    bindings,
    (lease) =>
      lease.runDirectory({
        binding,
        operation: create ? "private-create" : "private-check",
        name: NodePath.basename(destination),
      }),
    { mode: "exclusive" },
  );
  if (
    result.code !== 0 ||
    !result.destinationAfter ||
    result.destinationAfter.type !== "directory" ||
    (result.outcome === "applied" &&
      (result.flush.sourceDirectory > 0 || result.flush.destinationDirectory > 0))
  )
    throw new NativeFilePublicationError(
      `Native private retention provisioning refused (${result.codeDomain}:${result.code}).`,
      result,
    );
  // Kept only for the very folder the helper looked at, found already standing.
  if (
    before !== null &&
    canonicalParent === parent &&
    before.startsWith(`${result.destinationAfter.dev}:${result.destinationAfter.ino}:`)
  )
    validatedPrivate.set(destination, before);
  return NodePath.join(canonicalParent, NodePath.basename(destination));
}
function nativeFilePublicationArguments(
  request: NativeFilePublicationRequest,
): ReadonlyArray<string> {
  const { binding, operation, sourceName, destinationName } = request;
  validatePaths(binding);
  for (const name of [sourceName, destinationName]) {
    const separators = HostProcess.Platform.defaultValue() === "win32" ? /[\\/:\0]/u : /[/\0]/u;
    if (!name || name === "." || name === ".." || separators.test(name))
      throw new NativeFilePublicationError("Native entry names must be single components.", null);
  }
  return [
    "--protocol=1",
    operation,
    request.authority ?? nativeFileAuthority(),
    binding.rootPath,
    binding.parentRelativePath || ".",
    binding.recordPath,
    binding.rootIdentity.dev,
    binding.rootIdentity.ino,
    binding.parentIdentity.dev,
    binding.parentIdentity.ino,
    binding.recordIdentity.dev,
    binding.recordIdentity.ino,
    sourceName,
    destinationName,
  ];
}
export async function runNativeFilePublication(
  helperPath: string,
  request: NativeFilePublicationRequest,
) {
  return parseResult(await invoke(helperPath, nativeFilePublicationArguments(request)));
}

export type NativeFilePublicationParentBinding = Omit<NativeFileLeaseBinding, "mode">;
export interface NativeFilePublicationLease {
  /** Namespace work runs inside the bounded lock holder's owned retirement protocol. */
  readonly run: (request: NativeFilePublicationRequest) => Promise<NativeFilePublicationResult>;
  readonly runDirectory: (
    request: NativeFileDirectoryRequest,
  ) => Promise<NativeFilePublicationResult>;
  readonly remove: (
    directory: string,
    name: string,
    operation: "unlink" | "rmdir",
  ) => Promise<NativeFilePublicationResult>;
  readonly assertHeld: () => void;
}
const LeaseReply = Schema.Struct({
  version: Schema.Literal(1),
  lease: Schema.Literals(["acquired", "refused"]),
  code: Schema.Number,
  codeDomain: Schema.Literals(["errno", "win32"]),
});
const CommandExit = Schema.Struct({
  version: Schema.Literal(1),
  commandExit: Schema.Number,
  commandSignal: Schema.Number,
  code: Schema.Number,
  codeDomain: Schema.Literals(["errno", "win32"]),
});
const LeaseMessage = Schema.Union([LeaseReply, CommandExit, Result]);

const decodeLeaseMessage = Schema.decodeSync(Schema.fromJsonString(LeaseMessage));

/** The most folders one lease can bind: the helper refuses more (`lease_main`). */
export const NATIVE_LEASE_FOLDER_LIMIT = 256;

/** Cancellation can retire queued acquisition, never an acquired callback's native work. */
export async function withNativeFilePublicationLease<T>(
  helperPath: string,
  bindings: ReadonlyArray<NativeFileLeaseBinding>,
  body: (lease: NativeFilePublicationLease) => Promise<T>,
  options: { readonly mode: "shared" | "exclusive"; readonly signal?: AbortSignal },
): Promise<T> {
  if (
    !NodePath.isAbsolute(helperPath) ||
    bindings.length === 0 ||
    bindings.length > NATIVE_LEASE_FOLDER_LIMIT
  )
    throw new NativeFilePublicationError(
      "A publication lease needs an absolute host helper and 1–256 bound parents.",
      null,
    );
  if (options.signal?.aborted)
    throw new NativeFilePublicationError("Publication lease acquisition cancelled.", null);
  const arguments_ = ["--lease=1", options.mode];
  for (const binding of bindings) {
    validatePaths({ ...binding, recordPath: binding.rootPath });
    arguments_.push(
      binding.rootPath,
      binding.parentRelativePath || ".",
      binding.rootIdentity.dev,
      binding.rootIdentity.ino,
      binding.parentIdentity.dev,
      binding.parentIdentity.ino,
      binding.mode ?? options.mode,
    );
  }
  const ready = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const child = NodeChildProcess.spawn(helperPath, arguments_, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let acquired = false,
    alive = true,
    releasing = false,
    buffer = "",
    diagnostic = "";
  let acquisitionCancelled = false;
  let protocolError: NativeFilePublicationError | undefined;
  let pending:
    | {
        reply: NativeFilePublicationResult | null;
        result: PromiseWithResolvers<NativeFilePublicationResult>;
        retired: PromiseWithResolvers<void>;
      }
    | undefined;
  const failProtocol = (message: string) => {
    protocolError ??= new NativeFilePublicationError(message, null);
    if (!acquired) ready.reject(protocolError);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostic += chunk.slice(0, Math.max(0, 4096 - diagnostic.length));
  });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 65536) {
      buffer = "";
      failProtocol("Native lease protocol overflow; publication outcome unknown.");
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = decodeLeaseMessage(line);
        if ("lease" in message) {
          if (message.lease !== "acquired" || acquired || message.code !== 0) {
            failProtocol(
              `Native lease refused (${message.codeDomain}:${message.code}, ${diagnostic}).`,
            );
          } else if (acquisitionCancelled) {
            ready.reject(
              new NativeFilePublicationError("Publication lease acquisition cancelled.", null),
            );
          } else {
            acquired = true;
            options.signal?.removeEventListener("abort", abortAcquisition);
            ready.resolve();
          }
        } else if ("commandExit" in message) {
          if (!pending) {
            failProtocol("Unexpected native command retirement.");
            continue;
          }
          const command = pending;
          pending = undefined;
          command.retired.resolve();
          if (
            message.commandExit !== 0 ||
            message.commandSignal !== 0 ||
            message.code !== 0 ||
            !command.reply ||
            protocolError
          )
            command.result.reject(
              protocolError ??
                new NativeFilePublicationError(
                  "Native command did not retire with a complete reply; namespace outcome unknown.",
                  null,
                ),
            );
          else command.result.resolve(command.reply);
        } else if (pending && !pending.reply) {
          pending.reply = message;
        } else failProtocol("Unexpected native namespace reply.");
      } catch {
        failProtocol("Invalid native lease reply; namespace outcome unknown.");
      }
    }
  });
  child.on("error", (error) => {
    failProtocol(`Native lease process failed: ${error.message}`);
  });
  child.stdin.on("error", (error) => {
    failProtocol(`Native lease input failed: ${error.message}`);
  });
  child.on("close", (code, signal) => {
    alive = false;
    options.signal?.removeEventListener("abort", abortAcquisition);
    if (
      !(acquisitionCancelled && !acquired) &&
      (!acquired || !releasing || code !== 0 || signal !== null)
    ) {
      failProtocol(
        `Native lease ownership ended unexpectedly (exit=${code}, signal=${signal}, stderr=${diagnostic}).`,
      );
    }
    if (pending) {
      pending.retired.resolve();
      pending.result.reject(
        protocolError ??
          new NativeFilePublicationError(
            "Native lease ended before command retirement; namespace outcome unknown.",
            null,
          ),
      );
      pending = undefined;
    }
    retired.resolve({ code, signal });
  });
  function abortAcquisition() {
    if (!acquired) {
      acquisitionCancelled = true;
      ready.reject(
        new NativeFilePublicationError("Publication lease acquisition cancelled.", null),
      );
      child.kill();
    }
  }
  options.signal?.addEventListener("abort", abortAcquisition, { once: true });
  if (options.signal?.aborted) abortAcquisition();
  const runArguments = (
    arguments_: ReadonlyArray<string>,
    binding: NativeFileLeaseBinding,
    parentRequired = true,
    requiredRecord?: NativeFileIdentity,
  ) => {
    lease.assertHeld();
    const covered = bindings.some(
      (held) =>
        (held.mode ?? options.mode) === "exclusive" &&
        held.rootIdentity.dev === binding.rootIdentity.dev &&
        held.rootIdentity.ino === binding.rootIdentity.ino &&
        held.parentIdentity.dev === binding.parentIdentity.dev &&
        held.parentIdentity.ino === binding.parentIdentity.ino,
    );
    const recordCovered =
      !requiredRecord ||
      bindings.some(
        (held) =>
          (held.mode ?? options.mode) === "exclusive" &&
          held.parentIdentity.dev === requiredRecord.dev &&
          held.parentIdentity.ino === requiredRecord.ino,
      );
    if ((parentRequired && !covered) || !recordCovered)
      throw new NativeFilePublicationError(
        "Namespace mutation requires an exclusive lease on every actual parent.",
        null,
      );
    if (pending)
      throw new NativeFilePublicationError(
        "Native commands must retire serially inside a publication lease.",
        null,
      );
    const payload = Buffer.from(`${arguments_.join("\0")}\0`, "utf8");
    if (payload.length > 65536)
      throw new NativeFilePublicationError("Native command frame exceeds the bound.", null);
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length);
    payload.copy(frame, 4);
    const command = {
      reply: null,
      result: Promise.withResolvers<NativeFilePublicationResult>(),
      retired: Promise.withResolvers<void>(),
    };
    pending = command;
    child.stdin.write(frame);
    return command.result.promise;
  };
  const lease: NativeFilePublicationLease = {
    assertHeld: () => {
      if (!alive || !acquired || releasing || protocolError)
        throw (
          protocolError ??
          new NativeFilePublicationError("Native publication ownership is not held.", null)
        );
    },
    run: async (request) =>
      runArguments(
        nativeFilePublicationArguments(request),
        request.binding,
        request.operation !== "metadata" && request.operation !== "rmdir",
        request.operation === "mkdir" ? undefined : request.binding.recordIdentity,
      ),
    remove: async (directory, name, operation) => {
      const binding = bindings.find(
        (held) =>
          (held.mode ?? options.mode) === "exclusive" &&
          NodePath.join(held.rootPath, held.parentRelativePath) === directory,
      );
      if (!binding || !name || name === "." || name === ".." || /[/\\:\0]/u.test(name))
        throw new NativeFilePublicationError(
          "Removal needs a held directory and a single name.",
          null,
        );
      return runArguments(
        ["--remove=1", operation, binding.parentIdentity.dev, binding.parentIdentity.ino, name],
        binding,
      );
    },
    runDirectory: async (request) => runArguments(directoryArguments(request), request.binding),
  };
  try {
    await ready.promise;
    lease.assertHeld();
    const result = await body(lease);
    lease.assertHeld();
    return result;
  } finally {
    // A thrown/cancelled callback cannot release the lane while its native command still runs.
    if (pending) await pending.retired.promise;
    releasing = true;
    if (alive && !(acquisitionCancelled && !acquired)) child.stdin.end(Buffer.alloc(4));
    const exit = await retired.promise;
    if (
      protocolError ||
      (!(acquisitionCancelled && !acquired) && (exit.code !== 0 || exit.signal !== null))
    )
      // oxlint-disable-next-line no-unsafe-finally -- Failed lease retirement must override the body result; publication cannot report success.
      throw (
        protocolError ??
        new NativeFilePublicationError("Native publication lease failed to retire.", null)
      );
  }
}

/** Single-name removal and durability both use the lease holder's original folder handle. */
export async function removeNativeRetainedEntry(
  lease: NativeFilePublicationLease,
  directory: string,
  name: string,
) {
  let result = await lease.remove(directory, name, "unlink");
  if (
    (result.codeDomain === "errno" && [1, 21].includes(result.code)) ||
    (result.codeDomain === "win32" && result.code === 267)
  )
    result = await lease.remove(directory, name, "rmdir");
  if (result.code !== 0 || result.flush.sourceDirectory > 0)
    throw new NativeFilePublicationError(
      `Retained removal refused (${result.codeDomain}:${result.code}, flush=${result.flush.sourceDirectory}).`,
      result,
    );
  const current =
    HostProcess.Platform.defaultValue() === "win32"
      ? await import("./WindowsNativeFile.ts").then(({ windowsFileIdentity }) =>
          windowsFileIdentity(directory),
        )
      : await NodeFSP.stat(directory, { bigint: true });
  if (
    String(current?.dev) !== result.binding.parent?.dev ||
    String(current?.ino) !== result.binding.parent?.ino
  )
    throw new NativeFilePublicationError(
      "Retained folder moved during removal; journal settlement is pending.",
      result,
    );
}

const LinuxFolderInquiry = Schema.Struct({
  version: Schema.Literal(1),
  reason: Schema.NullOr(
    Schema.Literals([
      "unsupported-filesystem",
      "network-filesystem",
      "volatile-filesystem",
      "volume-unavailable",
      "no-volume-identity",
    ]),
  ),
  identity: Schema.NullOr(
    Schema.Struct({
      version: Schema.Literal(1),
      platform: Schema.Literal("linux"),
      volume: Schema.String.check(
        Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
      ),
      fileId: Schema.String.check(Schema.isPattern(/^\d{1,40}$/u)),
      subvolumeId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{1,40}$/u))),
    }),
  ),
});
const decodeLinuxFolderInquiry = Schema.decodeUnknownSync(
  Schema.fromJsonString(LinuxFolderInquiry),
);
/** UUID, inode and admission are observed together through a natively held folder/file. */
export async function nativeLinuxFileIdentity(
  path: string,
  directoryOnly: boolean,
  helperPath?: string,
) {
  const helper = helperPath ?? (await resolveNativeFilePublicationHelperPath());
  if (helper === undefined) return null;
  return decodeLinuxFolderInquiry(
    await invoke(helper, ["--linux-folder=1", path, directoryOnly ? "directory" : "entry"]),
  );
}
