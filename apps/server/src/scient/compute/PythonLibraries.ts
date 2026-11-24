// @effect-diagnostics nodeBuiltinImport:off -- Scient's own library folder, never the person's environment.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ComputeRuntimeError } from "@scientfactory/compute";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { ExecutionProcessPort } from "@scientfactory/execution";
import { privateKernelDirectory } from "./KernelSpecs.ts";
import {
  managedPythonProvisioningEnvironment,
  runOwnedProcess,
} from "./ManagedPythonProvisioner.ts";

/** A package name as an index lists it: no versions, extras, URLs or options. */
const DISTRIBUTION_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;

/** `python -c` reads the current folder first, which a kernel's packages do not include. */
const WITHOUT_CWD = "if sys.path and sys.path[0] in ('', '.'): del sys.path[0]";

/** The environment a Python runs in and its version, as the runtime probe reads them. */
const ENVIRONMENT_SCRIPT =
  "import json, platform, sys; print(json.dumps({'prefix': sys.prefix, 'version': platform.python_version()}))";

const decodeEnvironment = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ prefix: Schema.String, version: Schema.String })),
);

/**
 * Lists what a kernel can import, in its lookup order (environment with user site, private kernel
 * folder, each addition): `name<TAB>version` for every package, and a constraint for each version
 * an index can serve, a local build by its public version. Editable and direct installs have none.
 */
const INSTALLED_SCRIPT = [
  "import importlib.metadata as metadata, re, sys",
  WITHOUT_CWD,
  "served = re.compile(r'^(\\d+!)?\\d+(\\.\\d+)*((a|b|rc)\\d+)?(\\.post\\d+)?(\\.dev\\d+)?$')",
  "seen = {}",
  "for dist in [*metadata.distributions(), *metadata.distributions(path=sys.argv[3:])]:",
  "    name = dist.metadata['Name']",
  "    if not name:",
  "        continue",
  "    key = re.sub(r'[-_.]+', '-', name).lower()",
  "    if key not in seen:",
  "        version = dist.version or ''",
  "        public = version.split('+', 1)[0]",
  "        pinned = served.match(public) and dist.read_text('direct_url.json') is None",
  "        seen[key] = (version, name + '==' + public if pinned else None)",
  "with open(sys.argv[1], 'w', encoding='utf-8') as out:",
  "    out.write(''.join(pin + '\\n' for _, pin in seen.values() if pin))",
  "with open(sys.argv[2], 'w', encoding='utf-8') as out:",
  "    out.write(''.join(key + '\\t' + version + '\\n' for key, (version, _) in seen.items()))",
].join("\n");

const normalizedName = (name: string) => name.replace(/[-_.]+/gu, "-").toLowerCase();
const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$/u;

/**
 * Splits a resolution into what to install and what conflicts: a package the kernel already has
 * must be the version resolved (a local build by its public version), or the addition would run
 * against a version it was not resolved for.
 */
export const planInstall = (present: string, resolved: string) => {
  const have = new Map(
    present
      .split(/\r?\n/u)
      .filter((line) => line.includes("\t"))
      .map((line) => line.split("\t", 2) as [string, string]),
  );
  const missing: Array<string> = [];
  const conflicts: Array<string> = [];
  for (const line of resolved.split(/\r?\n/u)) {
    const match = PIN.exec(line.trim());
    if (match === null) continue;
    const [pin, name, version] = match as unknown as [string, string, string];
    const installed = have.get(normalizedName(name));
    if (installed === undefined) missing.push(pin);
    else if (installed !== version && installed.split("+")[0] !== version)
      conflicts.push(`${name} ${version}, but this environment has ${installed}`);
  }
  return { missing, conflicts };
};

/** Each finished addition, in the order kernels append them. */
const additionFolders = async (directory: string) =>
  (await NodeFSP.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => NodePath.join(directory, entry.name))
    .sort();

const librariesError = (message: string, cause?: unknown) =>
  new ComputeRuntimeError({
    operation: "prepare",
    message: message.slice(0, 4096),
    ...(cause === undefined ? {} : { cause }),
  });

const isDistributionName = (name: string) => DISTRIBUTION_NAME.test(name);

/**
 * Libraries Scient adds to a Python when code needs one, in a folder of its own per environment
 * and version, since compiled packages are built for one. A kernel finds them after the person's
 * own packages, so their versions always win, and nothing is written into their environment.
 */
export function makePythonLibraries(input: {
  readonly computeDir: string;
  readonly processes: ExecutionProcessPort;
  readonly environment: Readonly<Record<string, string>>;
  readonly uv: (signal: AbortSignal) => Promise<string>;
}) {
  /** Keyed by `sys.prefix`, so two virtual environments on one Python keep their own. */
  const folderFor = (prefix: string, version: string) =>
    privateKernelDirectory(input.computeDir, "python-libraries", prefix, version);
  /** One install at a time per folder, so two cannot write the same files. */
  const installing = new Map<string, Semaphore.Semaphore>();
  const installLock = (directory: string) => {
    let lock = installing.get(directory);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      installing.set(directory, lock);
    }
    return lock;
  };

  /** The folder for this Python, made if missing so a kernel can watch it from its start. */
  const folder = (prefix: string, version: string) =>
    Effect.tryPromise({
      try: async () => {
        const directory = folderFor(prefix, version);
        await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
        return directory;
      },
      catch: (cause) => librariesError("Scient could not prepare its library folder.", cause),
    });

  const identify = Effect.fn("PythonLibraries.identify")(function* (executable: string) {
    const stdout = yield* runOwnedProcess(input.processes, {
      runId: `scient-python-environment-${NodeCrypto.randomUUID()}`,
      executable,
      args: ["-I", "-c", ENVIRONMENT_SCRIPT],
      cwd: input.computeDir,
      environment: input.environment,
      stdoutOnly: true,
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((cause) => librariesError(`${executable} could not be checked.`, cause)),
    );
    return yield* decodeEnvironment(stdout.trim().split("\n").at(-1) ?? "").pipe(
      Effect.mapError((cause) => librariesError(`${executable} gave an unexpected answer.`, cause)),
    );
  });

  const run = (
    runId: string,
    executable: string,
    args: ReadonlyArray<string>,
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ) =>
    runOwnedProcess(input.processes, {
      runId: `scient-python-${runId}-${NodeCrypto.randomUUID()}`,
      executable,
      args,
      cwd,
      environment,
    });

  /**
   * Adds one package, and only what it needs that the kernel cannot already import, as one new
   * folder in the session's library folder. It resolves against what is installed, so the
   * person's versions stay in charge and are never downloaded again, and publishes the finished
   * addition with one rename, so a kernel never sees part of it.
   */
  const install = Effect.fn("PythonLibraries.install")(function* (target: {
    /** The Python the session runs, and the folders its kernel was launched with. */
    readonly executable: string;
    readonly folder: string;
    readonly privateFolder: string | null;
    readonly distribution: string;
  }) {
    const { executable, folder: directory, distribution } = target;
    if (!isDistributionName(distribution))
      return yield* librariesError(`"${distribution}" is not a package name.`);
    const { prefix, version } = yield* identify(executable);
    if (folderFor(prefix, version) !== directory)
      return yield* librariesError(
        "This Python changed since the session started. Restart the session, then add the package again.",
      );
    const uv = yield* Effect.tryPromise({
      try: (signal) => input.uv(signal),
      catch: (cause) => librariesError("Scient's package installer is unavailable.", cause),
    });
    const { UV_MANAGED_PYTHON: _ignored, ...environment } = managedPythonProvisioningEnvironment(
      input.environment,
      {
        targetRoot: directory,
        projectRoot: directory,
        cacheRoot: NodePath.join(input.computeDir, "cache", "python"),
      },
    );
    const work = `${directory}.install`;
    const files = {
      constraints: NodePath.join(work, "constraints.txt"),
      present: NodePath.join(work, "present.txt"),
      request: NodePath.join(work, "request.in"),
      resolved: NodePath.join(work, "resolved.txt"),
      staged: NodePath.join(work, "staged"),
    };
    const uvOptions = [
      "--python",
      executable,
      "--no-config",
      "--no-progress",
      "--system-certs",
      "--color",
      "never",
    ];
    const failed = (cause: { readonly message: string }) =>
      librariesError(`${distribution} could not be added: ${cause.message}`, cause);
    const fileError = (cause: unknown) =>
      librariesError(`Scient could not write ${distribution} to its library folder.`, cause);
    const added = Effect.gen(function* () {
      const additions = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.rm(work, { recursive: true, force: true });
          await NodeFSP.mkdir(work, { recursive: true, mode: 0o700 });
          await NodeFSP.writeFile(files.request, `${distribution}\n`);
          await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
          return await additionFolders(directory);
        },
        catch: fileError,
      });
      yield* run(
        "installed",
        executable,
        [
          "-c",
          INSTALLED_SCRIPT,
          files.constraints,
          files.present,
          ...(target.privateFolder === null ? [] : [target.privateFolder]),
          ...additions,
        ],
        input.computeDir,
        input.environment,
      ).pipe(Effect.mapError(failed));
      yield* run(
        "resolve",
        uv,
        [
          "pip",
          "compile",
          files.request,
          "--constraint",
          files.constraints,
          "--output-file",
          files.resolved,
          "--no-header",
          "--no-annotate",
          "--quiet",
          ...uvOptions,
        ],
        work,
        environment,
      ).pipe(Effect.mapError(failed));
      const [present, resolved] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            NodeFSP.readFile(files.present, "utf8"),
            NodeFSP.readFile(files.resolved, "utf8"),
          ]),
        catch: (cause) => librariesError("Scient could not read the resolved packages.", cause),
      });
      const { missing, conflicts } = planInstall(present, resolved);
      if (conflicts.length > 0)
        return yield* librariesError(`${distribution} needs ${conflicts.join("; ")}.`);
      if (missing.length === 0) return { added: missing };
      yield* run(
        "library",
        uv,
        ["pip", "install", "--target", files.staged, "--no-deps", ...uvOptions, ...missing],
        work,
        environment,
      ).pipe(Effect.mapError(failed));
      // One rename publishes the whole addition; a kernel appends it before its next cell.
      const name = `${yield* Clock.currentTimeMillis}-${NodeCrypto.randomUUID().slice(0, 8)}`;
      yield* Effect.tryPromise({
        try: () => NodeFSP.rename(files.staged, NodePath.join(directory, name)),
        catch: fileError,
      });
      return { added: missing };
    });
    return yield* installLock(directory).withPermits(1)(
      added.pipe(
        Effect.ensuring(
          Effect.promise(() =>
            NodeFSP.rm(work, { recursive: true, force: true }).catch(() => undefined),
          ),
        ),
      ),
    );
  });

  return { folder, install };
}

export type PythonLibraries = ReturnType<typeof makePythonLibraries>;
