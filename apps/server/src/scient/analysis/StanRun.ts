// @effect-diagnostics nodeBuiltinImport:off -- CmdStan, the model, its build and its draws are host files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AnalysisRunContext } from "@scientfactory/analysis";
import type { ExecutionRunId } from "@scientfactory/execution";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { pathModule } from "../compute/RuntimeDiscovery.ts";
import {
  ExecutionProcess,
  layer as executionProcessLayer,
} from "../execution/LocalExecutionProcess.ts";

/** The default of CmdStan, cmdstanpy and cmdstanr alike. */
const CHAINS = 4;

export const STAN_INSTALL_HINT =
  "Install CmdStan with cmdstanpy (pip install cmdstanpy, then python -m cmdstanpy.install_cmdstan) or with cmdstanr (cmdstanr::install_cmdstan() in R).";

type Exists = (path: string) => boolean;

const exe = (platform: NodeJS.Platform) => (platform === "win32" ? ".exe" : "");

/** The CmdStan a stanc belongs to: its `bin` folder sits beside CmdStan's makefile. */
export function cmdstanRoot(stanc: string, platform: NodeJS.Platform): string | null {
  const path = pathModule(platform);
  let real: string;
  try {
    real = NodeFS.realpathSync(stanc);
  } catch {
    return null;
  }
  const root = path.dirname(path.dirname(real));
  const parts = ["makefile", `bin/stansummary${exe(platform)}`, `bin/diagnose${exe(platform)}`];
  return parts.every((part) => NodeFS.existsSync(path.join(root, part))) ? root : null;
}

function readIfPresent(file: string): string | null {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * CmdStan's makefile pastes the paths it builds into shell commands, so only a path made of these
 * reaches make. The model's own folder never does: stanc reads it as an argument.
 */
export function stanMakeSafe(path: string, platform: NodeJS.Platform): boolean {
  // Letters in any script are safe; spaces and shell or make symbols are not.
  return (
    platform === "win32"
      ? /^(?:[A-Za-z]:)?[\p{L}\p{M}\p{N}_\-.\\/~+@]+$/u
      : /^[\p{L}\p{M}\p{N}_\-./~+@]+$/u
  ).test(path);
}

const stemOf = (model: string) => model.replace(/\.stan$/iu, "");

/** CmdStan's examples keep data beside the model as `<name>.data.json`; posteriordb uses `.json`. */
export function stanDataFile(model: string, exists: Exists = NodeFS.existsSync): string | null {
  const stem = stemOf(model);
  return [`${stem}.data.json`, `${stem}.json`, `${stem}.data.R`].find(exists) ?? null;
}

/** A `data` block that declares something, outside comments and apart from `transformed data`. */
export function stanNeedsData(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
  const body = /(?<!transformed\s+)\bdata\s*\{([^}]*)\}/u.exec(code)?.[1];
  return body !== undefined && body.trim().length > 0;
}

/** What CmdStan names the program and its chains: a Stan identifier. */
export function stanModelName(model: string, platform: NodeJS.Platform): string {
  const name = pathModule(platform)
    .basename(stemOf(model))
    .replace(/[^A-Za-z0-9_]/gu, "_");
  return /^[A-Za-z]/u.test(name) ? name : `m_${name}`;
}

/** Every Stan build Scient keeps, one folder per distinct C++ and CmdStan. */
function stanBuildsFolder(platform: NodeJS.Platform, temporary: string = NodeOS.tmpdir()): string {
  return pathModule(platform).join(temporary, "scient-stan");
}

/** Why a model cannot run before anything starts, or null. */
export function stanSourceProblem(
  model: string,
  platform: NodeJS.Platform,
  temporary: string = NodeOS.tmpdir(),
): string | null {
  const source = readIfPresent(model);
  if (source === null) return null;
  const path = pathModule(platform);
  if (stanNeedsData(source) && stanDataFile(model) === null) {
    return `${path.basename(model)} reads data. Put it in ${path.basename(stemOf(model))}.data.json beside the model.`;
  }
  const folder = path.dirname(model);
  if (folder.includes(",") && source.includes("#include")) {
    return `stanc reads its include folders as a list separated by commas, so a model that uses #include cannot sit in ${folder}. Rename the folder without the comma.`;
  }
  if (!stanMakeSafe(temporary, platform)) {
    return `Stan builds models in the temporary folder, and make cannot build in ${temporary} because its path has spaces or symbols. Set ${platform === "win32" ? "TEMP" : "TMPDIR"} to a folder whose path has only letters, digits and - _ .`;
  }
  return null;
}

export interface StanToolchain {
  readonly make: string;
  readonly environment: Readonly<Record<string, string>>;
  /** Folders Run put ahead of PATH, which change what builds. */
  readonly added?: ReadonlyArray<string>;
}

/** Windows reads variable names in any case. */
function variableName(environment: Readonly<Record<string, string>>, name: string): string {
  return Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
}

/** RTools 4.2 and later (cmdstanr), then RTools 4.0 (cmdstanpy's installer puts it in ~/.cmdstan). */
function windowsToolchains(environment: Readonly<Record<string, string>>) {
  const path = pathModule("win32");
  const read = (name: string) => environment[variableName(environment, name)];
  const drive = read("SystemDrive") ?? "C:";
  const home = read("USERPROFILE");
  const present = (folder: string | undefined): folder is string => folder !== undefined;
  return [
    ...["45", "44", "43", "42"]
      .flatMap((version) => [read(`RTOOLS${version}_HOME`), `${drive}\\rtools${version}`])
      .filter(present)
      .map((folder) => [
        path.join(folder, "usr", "bin"),
        path.join(folder, "x86_64-w64-mingw32.static.posix", "bin"),
      ]),
    ...[
      read("RTOOLS40_HOME"),
      `${drive}\\rtools40`,
      home === undefined ? undefined : path.join(home, ".cmdstan", "RTools40"),
    ]
      .filter(present)
      .map((folder) => [path.join(folder, "mingw64", "bin"), path.join(folder, "usr", "bin")]),
  ];
}

/**
 * make, and the PATH a build and its program need. Windows also needs a compiler, which CmdStan's
 * installers leave off PATH, and TBB's DLL, which the program loads from PATH.
 */
export function stanToolchain(input: {
  readonly root: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly exists?: Exists;
}): StanToolchain | null {
  const { environment, platform } = input;
  const exists = input.exists ?? NodeFS.existsSync;
  const path = pathModule(platform);
  const key = variableName(environment, "PATH");
  const separator = platform === "win32" ? ";" : ":";
  const entries = (environment[key] ?? "").split(separator).filter((entry) => entry.length > 0);
  const findIn = (folders: ReadonlyArray<string>, name: string) =>
    folders.map((folder) => path.join(folder, name)).find(exists);
  const configured = environment[variableName(environment, "MAKE")];
  const resolve = (folders: ReadonlyArray<string>, name: string) =>
    path.isAbsolute(name)
      ? exists(name)
        ? name
        : undefined
      : (findIn(folders, name) ??
        (platform === "win32" ? findIn(folders, `${name}.exe`) : undefined));
  if (platform !== "win32") {
    const make = resolve(entries, configured ?? "make");
    return make === undefined ? null : { make, environment };
  }
  const compiler = findIn(entries, "g++.exe")
    ? []
    : (windowsToolchains(environment).find((folders) => findIn(folders, "g++.exe")) ?? []);
  const tbb = path.join(input.root, "stan", "lib", "stan_math", "lib", "tbb");
  const folders = [tbb, ...compiler, ...entries];
  const make =
    configured === undefined
      ? (findIn(folders, "mingw32-make.exe") ?? findIn(folders, "make.exe"))
      : resolve(folders, configured);
  if (make === undefined || findIn(folders, "g++.exe") === undefined) return null;
  return {
    make,
    environment: { ...environment, [key]: folders.join(";") },
    added: [tbb, ...compiler],
  };
}

function stanToolchainHint(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "Building a Stan model needs Apple's command line tools: run xcode-select --install."
    : platform === "win32"
      ? "Building a Stan model needs make and a C++ compiler: install RTools 4.5 from CRAN, or install CmdStan from conda-forge, which brings its own."
      : "Building a Stan model needs make and a C++ compiler: install make and g++.";
}

export type StanSetup =
  | { readonly root: string; readonly toolchain: StanToolchain }
  | { readonly problem: string; readonly availability: "missing" | "invalid" };

/** The CmdStan this stanc belongs to and what builds with it, or what is missing and how to get it. */
export function stanSetup(
  stanc: string,
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  exists?: Exists,
): StanSetup {
  const root = cmdstanRoot(stanc, platform);
  if (root === null) {
    return {
      problem: `Found stanc at ${stanc}, which only checks a model. To draw samples, ${STAN_INSTALL_HINT.charAt(0).toLowerCase()}${STAN_INSTALL_HINT.slice(1)}`,
      availability: "missing",
    };
  }
  if (!stanMakeSafe(root, platform)) {
    return {
      problem: `CmdStan cannot build from ${root} because its path has spaces or symbols. Reinstall it in a folder whose path has only letters, digits and - _ .`,
      availability: "invalid",
    };
  }
  const toolchain = stanToolchain({ root, environment, platform, ...(exists ? { exists } : {}) });
  return toolchain === null
    ? { problem: `CmdStan is at ${root}. ${stanToolchainHint(platform)}`, availability: "missing" }
    : { root, toolchain };
}

/** stanc's arguments for this model, whose includes it reads against the model's own folder. */
function stancArgs(model: string, output: string, name: string, platform: NodeJS.Platform) {
  const folder = pathModule(platform).dirname(model);
  // stanc splits its include folders at commas; such a folder runs only models without includes.
  const includes = folder.includes(",") ? [] : [`--include-paths=${folder}`];
  return [...includes, `--name=${name}_model`, `--o=${output}`, model];
}

/**
 * Stop cannot reach a run before its steps start, so stanc gets 30 seconds here, far more than a
 * model takes; then its process tree is stopped. The run waits at most a further grace for that.
 */
const TRANSLATE_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 15_000;
/** Only stanc's first message is shown, so only the start of what it prints is kept. */
const MESSAGE_CHARACTERS = 64 * 1024;
/** A build unused this long goes; each run that uses one marks it used. */
const UNUSED_BUILD_MS = 30 * 24 * 60 * 60 * 1000;
/** Make variables every build uses, which change the program and so its folder. */
const MAKE_FLAGS = ["STAN_THREADS=true"];

async function readIfPresentAsync(file: string): Promise<Buffer | null> {
  try {
    return await NodeFSP.readFile(file);
  } catch {
    return null;
  }
}

/** stanc's first message, which names the file and line where translation stopped. */
function firstError(output: string): string {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const line = lines.find((text) => /error/iu.test(text)) ?? lines.find((text) => text !== "");
  return (line ?? "stanc exited without saying why.").slice(0, 1000);
}

type Translated = { readonly code: number } | { readonly timedOut: true };

/** Runs a tool with the process tree Run uses, keeping the start of what it prints. */
function runCaptured(input: {
  readonly runId: ExecutionRunId;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): Promise<{ readonly result: Translated; readonly output: string }> {
  let output = "";
  const program = Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ExecutionProcess;
      const handle = yield* processes.start({
        runId: input.runId,
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        environment: input.environment,
      });
      const read = handle.output.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            output += chunk.text.slice(0, Math.max(0, MESSAGE_CHARACTERS - output.length));
          }),
        ),
      );
      const finished = yield* Effect.all([read, handle.exitCode], { concurrency: 2 }).pipe(
        Effect.timeoutOption(input.timeoutMs),
      );
      if (Option.isSome(finished)) return { code: finished.value[1] } satisfies Translated;
      yield* handle.cancel.pipe(Effect.ignore);
      return { timedOut: true } satisfies Translated;
    }),
  ).pipe(
    Effect.provide(executionProcessLayer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.catchCause(() => Effect.succeed({ code: -1 } satisfies Translated)),
  );
  // A tree that outlives every kill must not hold the run for good.
  const deadline = NodeTimersPromises.setTimeout(
    input.timeoutMs + STOP_GRACE_MS,
    { timedOut: true } as const,
    {
      ref: false,
    },
  );
  return Promise.race([Effect.runPromise(program), deadline]).then((result) => ({
    result,
    output,
  }));
}

/**
 * This server's Stan builds. Runs of one adapter are serialized within a server, so a folder no
 * other process uses makes publishing a plain rename and pruning safe. A run's staging sits at
 * `<runs>/<project>/<run>/artifact-staging` under the server's own state, which names the server;
 * a staging folder laid out otherwise gets a key for this process alone, which is still unshared.
 */
export function stanServerBuilds(
  context: Pick<AnalysisRunContext, "projectId" | "runId" | "artifactStagingDirectory">,
  platform: NodeJS.Platform,
  temporary: string = NodeOS.tmpdir(),
): string {
  const path = pathModule(platform);
  const suffix = path.join(context.projectId, context.runId, "artifact-staging");
  const staging = context.artifactStagingDirectory;
  const state = staging.endsWith(`${path.sep}${suffix}`)
    ? staging.slice(0, staging.length - suffix.length - 1)
    : null;
  const key =
    state === null
      ? PROCESS_KEY
      : NodeCrypto.createHash("sha256").update(state).digest("hex").slice(0, 16);
  return path.join(stanBuildsFolder(platform, temporary), key);
}

const PROCESS_KEY = `process-${NodeProcess.pid}-${NodeCrypto.randomBytes(6).toString("hex")}`;

/** This server's builds unused for 30 days, and C++ a run left half-written a day ago. */
async function pruneBuilds(builds: string, platform: NodeJS.Platform, now: number) {
  const path = pathModule(platform);
  const remove = async (folder: string, age: number) => {
    const stats = await NodeFSP.stat(folder).catch(() => null);
    if (stats !== null && now - stats.mtimeMs > age) {
      await NodeFSP.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  const entries = await NodeFSP.readdir(builds).catch(() => []);
  const incoming = await NodeFSP.readdir(path.join(builds, "incoming")).catch(() => []);
  await Promise.all([
    ...entries
      .filter((entry) => entry !== "incoming")
      .map((entry) => remove(path.join(builds, entry), UNUSED_BUILD_MS)),
    ...incoming.map((entry) => remove(path.join(builds, "incoming", entry), 24 * 60 * 60 * 1000)),
  ]);
}

/** Every file under a folder, by its path inside it, in a stable order. */
async function filesUnder(folder: string, platform: NodeJS.Platform): Promise<Array<string>> {
  const path = pathModule(platform);
  const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) =>
        entry.isDirectory()
          ? (await filesUnder(path.join(folder, entry.name), platform)).map((file) =>
              path.join(entry.name, file),
            )
          : [entry.name],
      ),
  );
  return nested.flat();
}

/** Variables CmdStan's makefiles read that change the program they build. */
const BUILD_VARIABLE =
  /^(?:CXX|CC|CXXFLAGS|CPPFLAGS|LDFLAGS|LDLIBS|CXX_TYPE|O|MAKEFLAGS|STAN_\w+|TBB_\w+)$/u;

/**
 * Everything that changes the program built from this C++: CmdStan's makefiles, the version files
 * of Stan and its math library, the build variables, the toolchain folders Run adds, and the
 * compiler make finds. Headers reinstalled over the same CmdStan at the same version go unseen.
 */
async function buildIdentity(input: {
  readonly runId: ExecutionRunId;
  readonly cpp: Buffer;
  readonly root: string;
  readonly toolchain: StanToolchain;
  readonly platform: NodeJS.Platform;
}): Promise<string> {
  const { root, toolchain, platform } = input;
  const path = pathModule(platform);
  const key = NodeCrypto.createHash("sha256");
  const add = (label: string, value: string | Buffer) =>
    key.update(label).update("\0").update(value).update("\0");
  add("cpp", input.cpp);
  add("root", root);
  add("flags", MAKE_FLAGS.join(" "));
  const makeFiles = (await filesUnder(path.join(root, "make"), platform)).map((file) =>
    path.join("make", file),
  );
  const versions = [
    path.join("stan", "src", "stan", "version.hpp"),
    path.join("stan", "lib", "stan_math", "stan", "math", "version.hpp"),
  ];
  for (const file of ["makefile", ...makeFiles, ...versions]) {
    add(file, (await readIfPresentAsync(path.join(root, file))) ?? "");
  }
  const variables = Object.entries(toolchain.environment)
    .filter(([name]) => BUILD_VARIABLE.test(name))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of variables) add(`variable ${name}`, value);
  add("path", (toolchain.added ?? []).join("\n"));
  const compiler = stanCompiler(toolchain, platform, await makeCompiler(input));
  const stats = compiler === null ? null : await NodeFSP.stat(compiler).catch(() => null);
  add("compiler", stats === null ? "" : `${compiler} ${stats.size} ${stats.mtimeMs}`);
  return key.digest("hex").slice(0, 32);
}

/** What make said CXX is, by root, toolchain and make/local, for as long as this server runs. */
const makeCompilers = new Map<string, string>();

/**
 * The CXX CmdStan's makefiles settle on, make/local included, as their `print-CXX` target reports
 * it. Its first word is the compiler, which may be a wrapper such as ccache. Null when make cannot
 * say, and the usual default is fingerprinted instead.
 */
async function makeCompiler(input: {
  readonly runId: ExecutionRunId;
  readonly root: string;
  readonly toolchain: StanToolchain;
  readonly platform: NodeJS.Platform;
}): Promise<string | null> {
  const { root, toolchain, platform } = input;
  const local = await readIfPresentAsync(pathModule(platform).join(root, "make", "local"));
  const key = JSON.stringify([
    root,
    toolchain.make,
    Object.entries(toolchain.environment).sort(([left], [right]) => left.localeCompare(right)),
    local?.toString("base64") ?? null,
  ]);
  const known = makeCompilers.get(key);
  if (known !== undefined) return known;
  const { result, output } = await runCaptured({
    runId: input.runId,
    executable: toolchain.make,
    args: ["-s", ...MAKE_FLAGS, "print-CXX"],
    cwd: root,
    environment: toolchain.environment,
    timeoutMs: MAKE_PRINT_TIMEOUT_MS,
  });
  const named = /^CXX = *(\S+)/mu.exec(output)?.[1];
  if (!("code" in result) || result.code !== 0 || named === undefined) return null;
  makeCompilers.set(key, named);
  return named;
}

const MAKE_PRINT_TIMEOUT_MS = 10_000;

/** The compiler make named, or without it CXX or the usual default, as a real file on PATH. */
function stanCompiler(
  toolchain: StanToolchain,
  platform: NodeJS.Platform,
  fromMake: string | null,
): string | null {
  const path = pathModule(platform);
  const environment = toolchain.environment;
  const named =
    fromMake ??
    environment[variableName(environment, "CXX")] ??
    (platform === "darwin" ? "clang++" : platform === "win32" ? "g++.exe" : "g++");
  const entries = (environment[variableName(environment, "PATH")] ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter((entry) => entry.length > 0);
  const names = platform === "win32" && !/\.exe$/iu.test(named) ? [named, `${named}.exe`] : [named];
  const found = path.isAbsolute(named)
    ? named
    : entries
        .flatMap((entry) => names.map((name) => path.join(entry, name)))
        .find((file) => NodeFS.existsSync(file));
  if (found === undefined) return null;
  try {
    return NodeFS.realpathSync(found);
  } catch {
    return found;
  }
}

export type StanTranslation = { readonly folder: string } | { readonly problem: string };

/**
 * Translates the model into C++, then keeps it in a folder of this server's builds named by that
 * C++ and everything else that changes the program. Nothing in such a folder is ever replaced:
 * a change gets a new folder, and its program only ever comes from its own C++.
 */
export async function translateStan(input: {
  readonly runId: ExecutionRunId;
  readonly stanc: string;
  readonly root: string;
  readonly model: string;
  readonly toolchain: StanToolchain;
  readonly builds: string;
  readonly platform: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly now?: number;
}): Promise<StanTranslation> {
  const path = pathModule(input.platform);
  const name = stanModelName(input.model, input.platform);
  const now = input.now ?? Effect.runSync(Clock.currentTimeMillis);
  await pruneBuilds(input.builds, input.platform, now);
  const incoming = path.join(input.builds, "incoming");
  await NodeFSP.mkdir(incoming, { recursive: true });
  const next = path.join(incoming, `${name}.${NodeCrypto.randomBytes(6).toString("hex")}.hpp`);
  const timeoutMs = input.timeoutMs ?? TRANSLATE_TIMEOUT_MS;
  const { result, output } = await runCaptured({
    runId: input.runId,
    executable: input.stanc,
    args: stancArgs(input.model, next, name, input.platform),
    cwd: path.dirname(input.model),
    environment: input.toolchain.environment,
    timeoutMs,
  });
  const cpp = "code" in result && result.code === 0 ? await readIfPresentAsync(next) : null;
  if (cpp === null) {
    await NodeFSP.rm(next, { force: true });
    return {
      problem: `Stan could not translate the model: ${
        "timedOut" in result
          ? `stanc did not finish in ${Math.round(timeoutMs / 1000)} seconds.`
          : firstError(output)
      }`,
    };
  }
  const identity = await buildIdentity({
    runId: input.runId,
    cpp,
    root: input.root,
    toolchain: input.toolchain,
    platform: input.platform,
  });
  const folder = path.join(input.builds, identity);
  await NodeFSP.mkdir(folder, { recursive: true });
  const hpp = path.join(folder, `${name}.hpp`);
  if ((await readIfPresentAsync(hpp)) === null) await NodeFSP.rename(next, hpp);
  else await NodeFSP.rm(next, { force: true });
  await NodeFSP.utimes(folder, now / 1000, now / 1000).catch(() => undefined);
  return { folder };
}

/** A program a run built, to move into its folder once the whole run succeeded. */
export interface StanPublication {
  readonly from: string;
  readonly to: string;
}

/** Moves a run's program into its folder, where later runs sample it without building. */
export async function publishStan(publication: StanPublication): Promise<void> {
  await NodeFSP.rename(publication.from, publication.to).catch(() => undefined);
}

interface StanStep {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly showOutput?: "on-failure";
}

/**
 * Checks the model where it is, so stanc's warnings show with links; builds the program for the
 * C++ `translateStan` kept, unless one is built; samples four chains; then summarizes and
 * diagnoses them. A build goes to the folder's `build`, made empty first, and is published once
 * the run succeeds. Draws stay beside the model; build output and sampler settings show on failure.
 */
export function prepareStan(input: {
  readonly stanc: string;
  readonly root: string;
  readonly toolchain: StanToolchain;
  readonly model: string;
  readonly folder: string;
  readonly staging: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly threads?: number;
}): StanStep & {
  readonly before: ReadonlyArray<StanStep>;
  readonly publication: StanPublication | null;
} {
  const { model, platform, root } = input;
  const path = pathModule(platform);
  const name = stanModelName(model, platform);
  const posix = (file: string) => file.replaceAll("\\", "/");
  if (!stanMakeSafe(input.folder, platform) || !stanMakeSafe(root, platform)) {
    throw new Error(`make cannot build in ${input.folder} from ${root}.`);
  }
  const published = path.join(input.folder, `${name}${exe(platform)}`);
  const draws = path.join(path.dirname(model), `${path.basename(stemOf(model))}-draws`);
  NodeFS.mkdirSync(draws, { recursive: true });
  const chains = Array.from({ length: CHAINS }, (_, index) =>
    path.join(draws, `${name}_${index + 1}.csv`),
  );
  const summary = path.join(draws, "summary.csv");
  // stansummary refuses to replace its table, and an earlier run's chains must not look like this one's.
  for (const file of [...chains, summary]) NodeFS.rmSync(file, { force: true });
  const data = stanDataFile(model);
  const threads = Math.max(1, Math.min(CHAINS, input.threads ?? NodeOS.availableParallelism()));
  const step = (
    executable: string,
    args: ReadonlyArray<string>,
    extra: Partial<Pick<StanStep, "cwd" | "showOutput">> = {},
  ): StanStep => ({
    executable,
    args,
    cwd: input.cwd,
    environment: input.toolchain.environment,
    ...extra,
  });
  let program = published;
  let build: ReadonlyArray<StanStep> = [];
  let publication: StanPublication | null = null;
  if (!NodeFS.existsSync(published)) {
    // Emptied first, so nothing an earlier, interrupted build left is ever linked.
    const own = path.join(input.folder, "build");
    NodeFS.rmSync(own, { recursive: true, force: true });
    NodeFS.mkdirSync(own);
    NodeFS.copyFileSync(path.join(input.folder, `${name}.hpp`), path.join(own, `${name}.hpp`));
    program = path.join(own, `${name}${exe(platform)}`);
    publication = { from: program, to: published };
    // No .stan beside the C++, so CmdStan's makefile has no rule to translate: it only compiles.
    build = [
      step(input.toolchain.make, ["-s", ...MAKE_FLAGS, posix(program)], {
        cwd: root,
        showOutput: "on-failure",
      }),
    ];
  }
  const tool = (binary: string) => path.join(root, "bin", `${binary}${exe(platform)}`);
  return {
    ...step(tool("diagnose"), chains),
    publication,
    before: [
      step(input.stanc, stancArgs(model, path.join(input.staging, `${name}.hpp`), name, platform)),
      ...build,
      step(
        program,
        [
          "sample",
          `num_chains=${CHAINS}`,
          ...(data === null ? [] : ["data", `file=${data}`]),
          "output",
          `file=${path.join(draws, `${name}.csv`)}`,
          `profile_file=${path.join(draws, "profile.csv")}`,
          "refresh=0",
          `num_threads=${threads}`,
        ],
        { showOutput: "on-failure" },
      ),
      step(tool("stansummary"), ["-c", summary, ...chains]),
    ],
  };
}
