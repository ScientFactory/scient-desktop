// @effect-diagnostics nodeBuiltinImport:off -- CmdStan, the model, its build and its draws are host files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";

import { pathModule } from "../compute/RuntimeDiscovery.ts";

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

/** Where a model's C++ and program are kept between runs, away from the model's own path. */
export function stanBuildFolder(
  root: string,
  model: string,
  platform: NodeJS.Platform,
  temporary: string = NodeOS.tmpdir(),
): string {
  const key = NodeCrypto.createHash("sha256").update(`${root}\0${model}`).digest("hex");
  return pathModule(platform).join(temporary, "scient-stan", key.slice(0, 16));
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
  return { make, environment: { ...environment, [key]: folders.join(";") } };
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
 * model takes. Past that the run's first step translates instead, where Stop works.
 */
const TRANSLATE_TIMEOUT_MS = 30_000;

async function readIfPresentAsync(file: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Moves a translation into place when it differs from the one there, or null if it cannot. */
async function promote(next: string, target: string): Promise<"same" | "changed" | null> {
  const fresh = await readIfPresentAsync(next);
  if (fresh === null) return null;
  if (fresh === (await readIfPresentAsync(target))) return "same";
  return NodeFSP.rename(next, target).then(
    () => "changed" as const,
    () => null,
  );
}

/**
 * Translates the model into the build's C++, replacing it only when the C++ changed, so make
 * compiles exactly when the model or anything it includes changed. Its messages are left to the
 * run's first step. When it fails, the build's C++ and program are removed, so an earlier model
 * never runs as this one, and false tells `prepareStan` to translate in that step instead.
 */
export async function translateStan(input: {
  readonly stanc: string;
  readonly root: string;
  readonly model: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly temporary?: string;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const path = pathModule(input.platform);
  const name = stanModelName(input.model, input.platform);
  const build = stanBuildFolder(input.root, input.model, input.platform, input.temporary);
  await NodeFSP.mkdir(build, { recursive: true });
  const target = path.join(build, `${name}.hpp`);
  // Each attempt writes its own file, and the rename that promotes it is atomic. Two servers
  // building the same model at once are not coordinated beyond that.
  const unique = `${NodeProcess.pid}-${NodeCrypto.randomBytes(6).toString("hex")}`;
  const next = path.join(build, `${name}.${unique}.next.hpp`);
  const translated = await new Promise<boolean>((resolve) => {
    const child = NodeChildProcess.spawn(
      input.stanc,
      stancArgs(input.model, next, name, input.platform),
      {
        cwd: path.dirname(input.model),
        env: input.environment,
        stdio: "ignore",
        timeout: input.timeoutMs ?? TRANSLATE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
  const promoted = translated ? await promote(next, target) : null;
  await NodeFSP.rm(next, { force: true });
  const program = path.join(build, `${name}${exe(input.platform)}`);
  // make compares whole seconds on some systems, so new C++ written in the second the program was
  // built could look older. The program goes, and make builds it again.
  if (promoted === "changed") await NodeFSP.rm(program, { force: true });
  if (promoted !== null) return true;
  await Promise.all([target, program].map((file) => NodeFSP.rm(file, { force: true })));
  return false;
}

interface StanStep {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly showOutput?: "on-failure";
}

/**
 * Checks the model where it is, then compiles, samples four chains, summarizes and diagnoses them.
 * Unless `translateStan` left fresh C++ (`translated`), the check writes the build's C++ itself, so
 * a model that does not translate fails there with stanc's message. The draws stay beside the model;
 * build output and sampler settings show only on failure.
 */
export function prepareStan(input: {
  readonly stanc: string;
  readonly root: string;
  readonly toolchain: StanToolchain;
  readonly model: string;
  readonly staging: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly temporary?: string;
  readonly threads?: number;
  readonly translated: boolean;
}): StanStep & { readonly before: ReadonlyArray<StanStep> } {
  const { model, platform, root } = input;
  const path = pathModule(platform);
  const name = stanModelName(model, platform);
  const folder = path.dirname(model);
  const posix = (file: string) => file.replaceAll("\\", "/");
  const build = stanBuildFolder(root, model, platform, input.temporary);
  if (!stanMakeSafe(build, platform) || !stanMakeSafe(root, platform)) {
    throw new Error(`make cannot build in ${build} from ${root}.`);
  }
  NodeFS.mkdirSync(build, { recursive: true });
  // Without a .stan beside the C++, CmdStan's makefile has no rule to translate, so it only compiles.
  NodeFS.rmSync(path.join(build, `${name}.stan`), { force: true });
  // The check rewrites the C++ then, which make might not see as newer than this program.
  if (!input.translated)
    NodeFS.rmSync(path.join(build, `${name}${exe(platform)}`), { force: true });
  const draws = path.join(folder, `${path.basename(stemOf(model))}-draws`);
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
  const tool = (program: string) => path.join(root, "bin", `${program}${exe(platform)}`);
  return {
    ...step(tool("diagnose"), chains),
    before: [
      step(
        input.stanc,
        stancArgs(
          model,
          path.join(input.translated ? input.staging : build, `${name}.hpp`),
          name,
          platform,
        ),
      ),
      step(
        input.toolchain.make,
        ["-s", "STAN_THREADS=true", posix(path.join(build, `${name}${exe(platform)}`))],
        { cwd: root, showOutput: "on-failure" },
      ),
      step(
        path.join(build, `${name}${exe(platform)}`),
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
