// @effect-diagnostics nodeBuiltinImport:off -- CmdStan, the model, its build and its draws are host files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

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
 * reaches make. The model's own folder never does: its includes are copied into the build.
 */
export function stanMakeSafe(path: string, platform: NodeJS.Platform): boolean {
  // Letters in any script are safe; spaces and shell or make symbols are not.
  return (
    platform === "win32"
      ? /^(?:[A-Za-z]:)?[\p{L}\p{M}\p{N}_\-.\\/~+@,]+$/u
      : /^[\p{L}\p{M}\p{N}_\-./~+@,]+$/u
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

/** Models build in a copy here, kept between runs, since make reads the model's own path. */
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

const INCLUDE = /^[ \t]*#include[ \t]+(?:"([^"\n]+)"|<([^>\n]+)>|(\S+))/gmu;

/** Every file a model includes, by the name it uses. stanc reads each name against the model's folder. */
function includedFiles(
  source: string,
  folder: string,
  platform: NodeJS.Platform,
): ReadonlyMap<string, string> {
  const path = pathModule(platform);
  const found = new Map<string, string>();
  const pending = [source];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    for (const match of text.matchAll(INCLUDE)) {
      const name = (match[1] ?? match[2] ?? match[3])!;
      if (found.has(name)) continue;
      const contents = readIfPresent(path.resolve(folder, name));
      if (contents === null) continue;
      found.set(name, contents);
      pending.push(contents);
    }
  }
  return found;
}

/**
 * Copies the model and what it includes into the build when any of them changed, and only then, so
 * make rebuilds exactly when it must. Returns the folder stanc reads includes from, if any.
 */
function stageModel(input: {
  readonly source: string;
  readonly folder: string;
  readonly build: string;
  readonly name: string;
  readonly platform: NodeJS.Platform;
}): string | null {
  const path = pathModule(input.platform);
  const included = includedFiles(input.source, input.folder, input.platform);
  const staged = [...included].filter(([name]) => !path.isAbsolute(name));
  // A name may climb out of the model's folder with `..`, so the staged folder sits as deep.
  const climb = Math.max(
    0,
    ...staged.map(([name]) => name.split(/[\\/]/u).filter((part) => part === "..").length),
  );
  const top = path.join(input.build, "include");
  const includes = path.join(top, ...Array.from({ length: climb }, () => "up"));
  const signature = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.source, [...included].sort()]))
    .digest("hex");
  const record = path.join(input.build, `${input.name}.sources`);
  if (readIfPresent(record) !== signature) {
    NodeFS.rmSync(top, { recursive: true, force: true });
    for (const [name, contents] of staged) {
      const target = path.resolve(includes, name);
      if (path.relative(top, target).startsWith("..")) continue;
      NodeFS.mkdirSync(path.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, contents);
    }
    NodeFS.writeFileSync(path.join(input.build, `${input.name}.stan`), input.source);
    NodeFS.writeFileSync(record, signature);
  }
  return staged.length === 0 ? null : includes;
}

interface StanStep {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly showOutput?: "on-failure";
}

/**
 * Checks the model where it is, so errors name its own lines, builds a copy, samples four chains,
 * then summarizes and diagnoses them. The draws stay beside the model; the build output and the
 * sampler's settings show only when that step fails.
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
}): StanStep & { readonly before: ReadonlyArray<StanStep> } {
  const { model, platform, root } = input;
  const path = pathModule(platform);
  const name = stanModelName(model, platform);
  const folder = path.dirname(model);
  const posix = (file: string) => file.replaceAll("\\", "/");
  const source = NodeFS.readFileSync(model, "utf8");
  const build = stanBuildFolder(root, model, platform, input.temporary);
  if (!stanMakeSafe(build, platform) || !stanMakeSafe(root, platform)) {
    throw new Error(`make cannot build in ${build} from ${root}.`);
  }
  NodeFS.mkdirSync(build, { recursive: true });
  const includes = stageModel({ source, folder, build, name, platform });
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
      step(input.stanc, [
        `--include-paths=${folder}`,
        `--o=${path.join(input.staging, `${name}.hpp`)}`,
        model,
      ]),
      step(
        input.toolchain.make,
        [
          "-s",
          "STAN_THREADS=true",
          ...(includes === null ? [] : [`STANCFLAGS=--include-paths=${posix(includes)}`]),
          posix(path.join(build, `${name}${exe(platform)}`)),
        ],
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
