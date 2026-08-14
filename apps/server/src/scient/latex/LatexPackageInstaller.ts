/**
 * Places packages into the LaTeX distribution Scient installed and owns.
 *
 * TinyTeX is built to be extended at run time: the bundle carries TeX Live's
 * infrastructure plus a base set, and `tlmgr` fetches the rest. Every other
 * editor that ships it — RStudio, Quarto — reads the compiler's log and runs
 * that fetch on the reader's behalf, which is exactly what this service is for.
 *
 * Two rules shape it. It is only ever pointed at the managed distribution's own
 * `bin` directory, because a system TeX Live or MiKTeX belongs to the user and
 * Scient does not reach into it; and it never fails — a repository that cannot
 * be reached, a package that does not exist, a `tlmgr` that will not run all
 * come back as `failed`, leaving the caller with the compiler error it already
 * had rather than a second one about the fetch.
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import { latexEngineEnvironment } from "./latexCommand.ts";

export interface LatexPackageInstallInput {
  readonly packages: ReadonlyArray<string>;
  /** The managed distribution's `bin` directory; `tlmgr` is resolved inside it. */
  readonly binDirectory: string;
  /** Defaults to {@link INSTALL_TIMEOUT}; the eager collections install needs longer. */
  readonly timeout?: Duration.Input | undefined;
}

export interface LatexPackageInstallResult {
  /** Names `tlmgr` actually placed, including any the file search mapped to. */
  readonly installed: ReadonlyArray<string>;
  /** Requested names nothing could supply. */
  readonly failed: ReadonlyArray<string>;
}

export class LatexPackageInstaller extends Context.Service<
  LatexPackageInstaller,
  {
    readonly install: (input: LatexPackageInstallInput) => Effect.Effect<LatexPackageInstallResult>;
  }
>()("t3/scient/latex/LatexPackageInstaller") {}

/** One package is a small download; a failed build waits behind this. */
const INSTALL_TIMEOUT = "180 seconds";
/** The fallback is one index query against the repository, not a download. */
const SEARCH_TIMEOUT = "60 seconds";
/** `tlmgr` narrates every file it unpacks; only the verdict is read. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * How `tlmgr` says it has never heard of something. The wording has changed
 * across TeX Live releases and the exit code has too, so the verdict is read
 * out of the output rather than out of the status.
 */
const UNKNOWN_PACKAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /package\s+(\S+)\s+not present in repository/giu,
  /cannot find package\s+(\S+)/giu,
];

const SEARCH_PACKAGE_HEADING_PATTERN = /^(\S[^\s:]*):\s*$/u;
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Requested names `tlmgr` reported as absent from the repository. */
export function unknownPackagesFromInstall(
  output: string,
  requested: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const named = new Set<string>();
  for (const pattern of UNKNOWN_PACKAGE_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const name = (match[1] ?? "").replace(/[.,:;"'`]+$/u, "").toLowerCase();
      if (name.length > 0) named.add(name);
    }
  }
  return requested.filter((packageName) => named.has(packageName.toLowerCase()));
}

/**
 * Reads `tlmgr search --file` output, which prints a package name on its own
 * line followed by the tab-indented paths it ships. The answer is the package
 * that ships a file of this name, never merely the first one listed: a
 * substring query matches longer names too, and installing one of those would
 * be a download that cannot fix the build.
 */
export function owningPackageFromSearch(output: string, fileStem: string): string | null {
  const wanted = `${fileStem.toLowerCase()}.`;
  let current: string | null = null;
  for (const line of output.split(/\r?\n/u)) {
    const heading = SEARCH_PACKAGE_HEADING_PATTERN.exec(line);
    if (heading?.[1] !== undefined) {
      current = heading[1];
      continue;
    }
    if (current === null) continue;
    const filePath = line.trim().replaceAll("\\", "/");
    const baseName = (filePath.split("/").at(-1) ?? filePath).toLowerCase();
    if (baseName.startsWith(wanted) && PACKAGE_NAME_PATTERN.test(current)) return current;
  }
  return null;
}

function dedupe(names: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(names)];
}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const pathDelimiter = platform === "win32" ? ";" : ":";

  /**
   * `tlmgr` lives beside `latexmk` in the distribution, as a `.bat` shim on
   * Windows. `ProcessRunner` resolves that shim and runs it through the shell,
   * which is the only way a `.bat` starts at all.
   */
  const tlmgrPath = (binDirectory: string) =>
    path.join(binDirectory, platform === "win32" ? "tlmgr.bat" : "tlmgr");

  /**
   * One bounded `tlmgr` run, or `null` when it could not be run at all. The
   * distribution's own `bin` directory leads the child's PATH exactly as it
   * does for a compile, because `tlmgr` drives the same helpers `latexmk` does.
   */
  const runTlmgr = (input: {
    readonly binDirectory: string;
    readonly args: ReadonlyArray<string>;
    readonly timeout: Duration.Input;
  }) =>
    processRunner
      .run({
        command: tlmgrPath(input.binDirectory),
        args: input.args,
        timeout: input.timeout,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
        env: latexEngineEnvironment({
          base: {},
          hostEnvironment,
          binDirectory: input.binDirectory,
          pathDelimiter,
        }),
      })
      .pipe(
        Effect.map((result) => ({
          ok: !result.timedOut && result.code === 0,
          output: `${result.stdout}\n${result.stderr}`,
        })),
        // A distribution without a `tlmgr` is not a defect here; it is a build
        // that keeps the error it already had.
        Effect.orElseSucceed(() => null),
      );

  /** Maps a missing file back to the package that ships it. Costs one query. */
  const searchOwningPackage = (input: {
    readonly binDirectory: string;
    readonly packageName: string;
  }) =>
    Effect.gen(function* () {
      const result = yield* runTlmgr({
        binDirectory: input.binDirectory,
        // The query is a path fragment: `/mathtools.` reaches the package that
        // ships `mathtools.sty` or `mathtools.cls` without stopping at the
        // extension the compiler happened to ask for.
        args: ["search", "--global", "--file", `/${input.packageName}.`],
        timeout: SEARCH_TIMEOUT,
      });
      if (result === null || !result.ok) return null;
      return owningPackageFromSearch(result.output, input.packageName);
    });

  const install = (input: LatexPackageInstallInput) =>
    Effect.gen(function* () {
      const requested = dedupe(input.packages);
      if (requested.length === 0) return { installed: [], failed: [] };
      if (input.binDirectory.length === 0) return { installed: [], failed: requested };

      const timeout = input.timeout ?? INSTALL_TIMEOUT;
      const attempt = yield* runTlmgr({
        binDirectory: input.binDirectory,
        args: ["install", ...requested],
        timeout,
      });
      if (attempt === null) return { installed: [], failed: requested };

      const unknown = unknownPackagesFromInstall(attempt.output, requested);
      const named = requested.filter((packageName) => !unknown.includes(packageName));
      // `tlmgr` places what it can and names what it could not find, so a run
      // that only stumbled over unknown packages still installed the rest.
      const installed: string[] = attempt.ok || unknown.length > 0 ? [...named] : [];
      const failed: string[] = installed.length === named.length ? [] : [...named];
      if (unknown.length === 0) return { installed, failed };

      // A package named after the file is the common case, not the rule:
      // `algorithm.sty` comes from `algorithms`. One search says which.
      const owners: string[] = [];
      for (const packageName of unknown) {
        const owner = yield* searchOwningPackage({
          binDirectory: input.binDirectory,
          packageName,
        });
        if (owner === null || installed.includes(owner) || owners.includes(owner)) {
          failed.push(packageName);
          continue;
        }
        owners.push(owner);
      }
      if (owners.length === 0) return { installed, failed };

      const mapped = yield* runTlmgr({
        binDirectory: input.binDirectory,
        args: ["install", ...owners],
        timeout,
      });
      if (mapped?.ok === true) return { installed: [...installed, ...owners], failed };
      return {
        installed,
        failed: [...failed, ...unknown.filter((name) => !failed.includes(name))],
      };
    });

  return LatexPackageInstaller.of({ install });
});

export const layer = Layer.effect(LatexPackageInstaller, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
