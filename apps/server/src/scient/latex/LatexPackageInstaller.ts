/**
 * Places packages into the LaTeX distribution Scient installed and owns.
 *
 * TinyTeX is built to be extended at run time: the bundle carries TeX Live's
 * infrastructure plus a base set, and `tlmgr` fetches the rest. Every other
 * editor that ships it — RStudio, Quarto — reads the compiler's log and runs
 * that fetch on the reader's behalf, which is exactly what this service is for.
 *
 * Three rules shape it. It is only ever pointed at the managed distribution's
 * own `bin` directory, because a system TeX Live or MiKTeX belongs to the user
 * and Scient does not reach into it; it never fails — a repository that cannot
 * be reached, a package that does not exist, a `tlmgr` that will not run all
 * come back as `failed`, leaving the caller with the compiler error it already
 * had rather than a second one about the fetch; and it only ever reports a
 * package as installed once the engine can actually see the file it was
 * fetched for.
 *
 * Every `tlmgr` run goes through one permit, because `tlmgr` writes the
 * distribution's own package database: two of them against one tree is the
 * "another tlmgr is running" failure at best and a corrupt database at worst.
 * Three documents can compile at once, and the install that seeds a fresh
 * distribution overlaps a first build, so the collision is ordinary rather
 * than exotic.
 *
 * Every `tlmgr` run also goes through the execution port rather than
 * `ProcessRunner`, because a fetch is a long process with children. A big
 * collection can outlive any budget worth setting, and `ProcessRunner` has no
 * process-tree kill: on Windows it would stop the `tlmgr.bat` shim and leave
 * the `perl` doing the actual work running, which then finishes the install
 * minutes after the build already reported it failed — and rebuilds the file
 * index underneath a compile that was told the package was never placed. The
 * port's `cancel` is `taskkill /T /F`, so a budget that elapses ends the whole
 * tree. Short read-only probes (`kpsewhich`) stay on `ProcessRunner`, which is
 * what it is for.
 */
import { ExecutionRunId } from "@scientfactory/execution";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../../processRunner.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { latexEngineEnvironment } from "./latexCommand.ts";

export interface LatexPackageInstallInput {
  readonly packages: ReadonlyArray<string>;
  /** The managed distribution's `bin` directory; `tlmgr` is resolved inside it. */
  readonly binDirectory: string;
  /** Defaults to {@link INSTALL_TIMEOUT}; the eager collections install needs longer. */
  readonly timeout?: Duration.Input | undefined;
  /**
   * The files this round is fetching, as the engine named them
   * (`mathtools.sty`). When present, a package only counts as installed once
   * `kpsewhich` can find the file it was fetched for; see `install`.
   */
  readonly expectedFiles?: ReadonlyArray<string> | undefined;
}

export interface LatexPackageInstallResult {
  /** Names `tlmgr` placed and the engine can now find, including any the file search mapped to. */
  readonly installed: ReadonlyArray<string>;
  /** Requested names nothing could supply, or that nothing can see yet. */
  readonly failed: ReadonlyArray<string>;
}

export interface LatexFileVisibilityInput {
  readonly files: ReadonlyArray<string>;
  readonly binDirectory: string;
}

export class LatexPackageInstaller extends Context.Service<
  LatexPackageInstaller,
  {
    readonly install: (input: LatexPackageInstallInput) => Effect.Effect<LatexPackageInstallResult>;
    /**
     * Which of these files the engine cannot find. A probe that could not run
     * at all answers "found", because a distribution whose `kpsewhich` is
     * missing must not be one where nothing is ever visible.
     */
    readonly unresolvedFiles: (
      input: LatexFileVisibilityInput,
    ) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/scient/latex/LatexPackageInstaller") {}

/**
 * What one install invocation gets. `collection-latexrecommended` is tens of
 * megabytes over whatever connection the reader has, and the old three-minute
 * budget is what turned a slow fetch into an orphaned `tlmgr` finishing behind
 * a build that had already given up. The budget is now long enough that
 * elapsing it means something is genuinely wrong, and short enough that a
 * wedged fetch does not hold a document forever.
 */
const INSTALL_TIMEOUT = "10 minutes";
/** The fallback is one index query against the repository, not a download. */
const SEARCH_TIMEOUT = "60 seconds";
/** Rewriting the distribution's file index is local work over a known tree. */
const INDEX_REFRESH_TIMEOUT = "120 seconds";
/** One `kpsewhich` lookup against an index that is already on disk. */
const FILE_PROBE_TIMEOUT = "20 seconds";
const FILE_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
/** Names per probe. A preamble's worth fits in one; nothing here builds a giant argv. */
const MAX_FILES_PER_PROBE = 40;
/** `tlmgr` narrates every file it unpacks; only the verdict, at the end, is read. */
const MAX_OUTPUT_BYTES = 512 * 1024;

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
/** A file name a probe may be handed: a bare name, never a path or an option. */
const PROBE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Names the repository has already said it has never heard of, so the file
 * search behind them is paid for once rather than on every save. A document
 * with `\usepackage{mystyle}` — the author's own file, or a typo — asks for
 * the same name every rebuild, and the per-build attempted set cannot see
 * across builds. Short-lived because the answer is only as true as the
 * repository state it came from, and dropped wholesale when a managed install
 * finishes, which is exactly when a "not present" answer stops being true.
 */
const FAILED_SEARCH_TTL_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_FAILED_SEARCHES = 64;
const failedSearches = new Map<string, number>();

/** Forgets every remembered failure; a new distribution has its own answers. */
export function clearFailedPackageSearches(): void {
  failedSearches.clear();
}

function rememberFailedSearch(packageName: string, nowEpochMs: number): void {
  const identity = packageName.toLowerCase();
  failedSearches.delete(identity);
  if (failedSearches.size >= MAX_REMEMBERED_FAILED_SEARCHES) {
    const oldest = failedSearches.keys().next().value;
    if (oldest !== undefined) failedSearches.delete(oldest);
  }
  failedSearches.set(identity, nowEpochMs + FAILED_SEARCH_TTL_MS);
}

function searchFailedRecently(packageName: string, nowEpochMs: number): boolean {
  const identity = packageName.toLowerCase();
  const expiresAtEpochMs = failedSearches.get(identity);
  if (expiresAtEpochMs === undefined) return false;
  if (expiresAtEpochMs > nowEpochMs) return true;
  failedSearches.delete(identity);
  return false;
}

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

/** The `.sty`/`.cls` a package name is fetched for; `mathtools` → `mathtools.sty`. */
function packageOfFile(fileName: string): string | null {
  const baseName = fileName.replaceAll("\\", "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  if (dot <= 0) return null;
  const stem = baseName.slice(0, dot);
  return PACKAGE_NAME_PATTERN.test(stem) ? stem.toLowerCase() : null;
}

function dedupe(names: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(names)];
}

/**
 * The newest bytes a run printed, up to {@link MAX_OUTPUT_BYTES}. `tlmgr`
 * narrates every file it unpacks and the verdict is the last thing it says, so
 * whole chunks fall off the front rather than the end.
 */
interface OutputTail {
  readonly chunks: ReadonlyArray<{ readonly text: string; readonly bytes: number }>;
  readonly bytes: number;
}

const emptyOutputTail: OutputTail = { chunks: [], bytes: 0 };

export function appendOutputTail(state: OutputTail, text: string): OutputTail {
  const bytes = Buffer.byteLength(text);
  const chunks = [...state.chunks, { text, bytes }];
  let total = state.bytes + bytes;
  // The newest chunk always stays, however large it is; a single oversized
  // write is still the only thing that run said.
  while (total > MAX_OUTPUT_BYTES && chunks.length > 1) {
    const oldest = chunks.shift();
    if (oldest === undefined) break;
    total -= oldest.bytes;
  }
  return { chunks, bytes: total };
}

export function renderOutputTail(state: OutputTail): string {
  return state.chunks.map((chunk) => chunk.text).join("");
}

export interface TexliveScriptInvocation {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Directories that must lead the child's PATH, already joined. On Windows the
   * bundled `perl` comes first, exactly as `tlmgr.bat` orders them.
   */
  readonly pathPrefix: string;
  /** Everything else the wrapper would have set, `PERL5LIB` above all. */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * How to run `tlmgr` without the shim.
 *
 * On Windows TeX Live ships `tlmgr` as `tlmgr.bat`, and a `.bat` cannot be
 * spawned without a shell — which is a shell process between Scient and the
 * work, and the thing that survives a kill aimed at the shim. The wrapper is
 * not doing anything a caller cannot do directly: it derives the installation
 * root from its own location, puts the bundled `perl` and the distribution's
 * `bin` on PATH, points `PERL5LIB` at the bundled library, and runs
 * `tlpkg/tlperl/bin/perl.exe texmf-dist/scripts/texlive/tlmgr.pl` with the
 * arguments it was given. (Its remaining job — running a self-update script
 * left behind by `tlmgr update --self` — is for an update Scient never asks
 * for.) Encoding that here removes the shell, and with it the shim's argument
 * quoting, from the install path entirely. Elsewhere `tlmgr` is an ordinary
 * executable script and is run as itself.
 */
export function texliveScriptInvocation(input: {
  readonly binDirectory: string;
  readonly script: "tlmgr" | "mktexlsr";
  readonly args: ReadonlyArray<string>;
  readonly platform: NodeJS.Platform;
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly dirname: (segment: string) => string;
  readonly pathDelimiter: string;
}): TexliveScriptInvocation {
  if (input.platform !== "win32") {
    return {
      executable: input.join(input.binDirectory, input.script),
      args: [...input.args],
      pathPrefix: input.binDirectory,
      environment: {},
    };
  }
  // `mktexlsr.exe` is a real executable in the same directory; only `tlmgr` is
  // a `.bat`, because only `tlmgr` needs the self-update dance.
  if (input.script === "mktexlsr") {
    return {
      executable: input.join(input.binDirectory, "mktexlsr.exe"),
      args: [...input.args],
      pathPrefix: input.binDirectory,
      environment: {},
    };
  }
  // `<root>/bin/windows` → `<root>`, the same two steps `tlmgr.bat` takes.
  const texliveRoot = input.dirname(input.dirname(input.binDirectory));
  const perlDirectory = input.join(texliveRoot, "tlpkg", "tlperl", "bin");
  return {
    executable: input.join(perlDirectory, "perl.exe"),
    args: [input.join(texliveRoot, "texmf-dist", "scripts", "texlive", "tlmgr.pl"), ...input.args],
    pathPrefix: `${perlDirectory}${input.pathDelimiter}${input.binDirectory}`,
    environment: { PERL5LIB: input.join(texliveRoot, "tlpkg", "tlperl", "lib") },
  };
}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  // `tlmgr` writes the distribution's own package database, so two runs
  // against one tree are a lock error at best. Every run below takes this.
  const tlmgrGate = yield* Semaphore.make(1);
  // The port wants an id per run. Nothing reads it here; it only has to be
  // stable and unique enough to tell two runs apart in a trace.
  const runCounter = yield* Ref.make(0);

  const nextRunId = Ref.updateAndGet(runCounter, (count) => count + 1).pipe(
    Effect.map((count) => ExecutionRunId.make(`scient-latex-tlmgr-${String(count)}`)),
  );

  const scriptEnvironment = (invocation: TexliveScriptInvocation) =>
    latexEngineEnvironment({
      base: invocation.environment,
      hostEnvironment,
      // Already joined with the delimiter when more than one directory leads.
      binDirectory: invocation.pathPrefix,
      pathDelimiter,
    });

  /**
   * One bounded run of a distribution script, or `null` when it could not be
   * run at all. Runs one at a time against the tree. The distribution's own
   * `bin` directory leads the child's PATH exactly as it does for a compile,
   * because these tools drive the same helpers `latexmk` does.
   *
   * A budget that elapses cancels the whole process tree, so nothing this
   * service started can still be writing to the distribution after the caller
   * has been told the run failed.
   */
  const runScript = (input: {
    readonly binDirectory: string;
    readonly script: "tlmgr" | "mktexlsr";
    readonly args: ReadonlyArray<string>;
    readonly timeout: Duration.Input;
  }) =>
    tlmgrGate.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          const invocation = texliveScriptInvocation({
            binDirectory: input.binDirectory,
            script: input.script,
            args: input.args,
            platform,
            join: (...segments) => path.join(...segments),
            dirname: (segment) => path.dirname(segment),
            pathDelimiter,
          });
          const handle = yield* processes.start({
            runId: yield* nextRunId,
            executable: invocation.executable,
            args: invocation.args,
            cwd: input.binDirectory,
            environment: scriptEnvironment(invocation),
          });
          const outputRef = yield* Ref.make(emptyOutputTail);
          const outputFiber = yield* handle.output.pipe(
            Stream.runForEach((chunk) =>
              Ref.update(outputRef, (state) => appendOutputTail(state, chunk.text)),
            ),
            Effect.catchCause((cause) =>
              Effect.logDebug("tlmgr output stream ended early", { cause }),
            ),
            Effect.forkScoped,
          );
          const exitCode = yield* handle.exitCode.pipe(Effect.timeoutOption(input.timeout));
          // The port's cancel is a tree kill. Without it the shim dies and the
          // `perl` underneath keeps installing into a distribution whose owner
          // has already moved on, which is the orphan this service exists to
          // not create.
          if (Option.isNone(exitCode)) yield* handle.cancel.pipe(Effect.ignoreCause());
          yield* Fiber.join(outputFiber).pipe(Effect.ignoreCause());
          return {
            ok: Option.isSome(exitCode) && exitCode.value === 0,
            output: renderOutputTail(yield* Ref.get(outputRef)),
          };
        }),
      ).pipe(
        // A distribution without a `tlmgr` is not a defect here; it is a
        // build that keeps the error it already had.
        Effect.orElseSucceed(() => null),
      ),
    );

  const runTlmgr = (input: {
    readonly binDirectory: string;
    readonly args: ReadonlyArray<string>;
    readonly timeout: Duration.Input;
  }) => runScript({ ...input, script: "tlmgr" });

  /**
   * Which of these the engine cannot find, or `null` when the probe itself
   * could not answer.
   *
   * One `kpsewhich` answers for a whole list: it prints a line per argument,
   * in order, and leaves the line empty for a name it could not resolve. That
   * matters because this runs before every compile of a managed build — a
   * process per package would put a second of spawning in front of every save
   * of a paper with a real preamble.
   */
  const probeFiles = (input: {
    readonly binDirectory: string;
    readonly fileNames: ReadonlyArray<string>;
  }) =>
    processRunner
      .run({
        command: path.join(
          input.binDirectory,
          platform === "win32" ? "kpsewhich.exe" : "kpsewhich",
        ),
        args: input.fileNames,
        timeout: FILE_PROBE_TIMEOUT,
        maxOutputBytes: FILE_PROBE_MAX_OUTPUT_BYTES,
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
        Effect.map((result) => {
          // `kpsewhich` exits with the number of names it could not resolve, so
          // a non-zero status is an answer rather than a failure; only a
          // timeout means it never gave one.
          if (result.timedOut) return null;
          const lines = result.stdout.split(/\r?\n/u);
          return input.fileNames.filter((_unused, index) => (lines[index] ?? "").trim() === "");
        }),
        // A probe that will not run at all answers "found" for everything: a
        // distribution whose `kpsewhich` is missing must not be one where
        // nothing is ever visible, or no build could ever recompile.
        Effect.orElseSucceed(() => null),
      );

  const unresolvedFiles = (input: LatexFileVisibilityInput) =>
    Effect.gen(function* () {
      if (input.binDirectory.length === 0) return [];
      // The names come out of a transcript the document wrote, and these reach
      // argv too.
      const named = dedupe(input.files).filter((fileName) =>
        PROBE_FILE_NAME_PATTERN.test(fileName),
      );
      const unresolved: string[] = [];
      for (let start = 0; start < named.length; start += MAX_FILES_PER_PROBE) {
        const batch = named.slice(start, start + MAX_FILES_PER_PROBE);
        const answer = yield* probeFiles({ binDirectory: input.binDirectory, fileNames: batch });
        if (answer !== null) unresolved.push(...answer);
      }
      return unresolved;
    });

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

  /** The fetch itself, over names already deduplicated and checked. */
  const installNamed = (input: {
    readonly packages: ReadonlyArray<string>;
    readonly binDirectory: string;
    readonly timeout: Duration.Input;
  }) =>
    Effect.gen(function* () {
      const requested = input.packages;
      if (input.binDirectory.length === 0) return { installed: [], failed: requested };

      const timeout = input.timeout;
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
      const nowEpochMs = yield* Clock.currentTimeMillis;
      for (const packageName of unknown) {
        // A name this session already searched for and did not find is not
        // searched for again: a document with a typo in a `\usepackage` asks
        // for it on every save, and the answer does not change that fast.
        if (searchFailedRecently(packageName, nowEpochMs)) {
          failed.push(packageName);
          continue;
        }
        const owner = yield* searchOwningPackage({
          binDirectory: input.binDirectory,
          packageName,
        });
        if (owner === null || installed.includes(owner) || owners.includes(owner)) {
          if (owner === null) rememberFailedSearch(packageName, nowEpochMs);
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

  /**
   * Holds the outcome to what the caller can actually observe.
   *
   * "`tlmgr` finished" and "the engine can find the file" are two different
   * moments. `tlmgr` unpacks the files first and rebuilds the distribution's
   * `ls-R` file index afterwards, as a post-action, and a compile started
   * between the two searches an index that does not mention what was just
   * placed — the same "File `microtype.sty' not found" the round was fetching
   * for, from a tree that already has it. So a round that placed something
   * asks `kpsewhich`, rebuilds the index once itself if the answer is no, and
   * reports as installed only what the answer is yes for. Whatever is still
   * invisible is a failed name, which the caller already knows how to say.
   */
  const gateOnVisibility = (input: {
    readonly outcome: LatexPackageInstallResult;
    readonly expectedFiles: ReadonlyArray<string>;
    readonly binDirectory: string;
  }) =>
    Effect.gen(function* () {
      const expected = dedupe(input.expectedFiles);
      if (expected.length === 0 || input.outcome.installed.length === 0) return input.outcome;

      let unresolved = yield* unresolvedFiles({
        files: expected,
        binDirectory: input.binDirectory,
      });
      if (unresolved.length > 0) {
        // One rebuild of the index, then the same question again. `tlmgr` runs
        // this itself; running it here is only how a caller stops waiting for
        // it to get around to it.
        yield* runScript({
          binDirectory: input.binDirectory,
          script: "mktexlsr",
          args: [],
          timeout: INDEX_REFRESH_TIMEOUT,
        });
        unresolved = yield* unresolvedFiles({
          files: unresolved,
          binDirectory: input.binDirectory,
        });
      }
      if (unresolved.length === 0) return input.outcome;

      // Nothing the round fetched became visible, so there is nothing for the
      // caller to compile again for.
      if (unresolved.length === expected.length) {
        return {
          installed: [],
          failed: dedupe([...input.outcome.failed, ...input.outcome.installed]),
        };
      }
      const invisible = new Set(
        unresolved.map((fileName) => packageOfFile(fileName)).filter((name) => name !== null),
      );
      const stillMissing = input.outcome.installed.filter((packageName) =>
        invisible.has(packageName.toLowerCase()),
      );
      return {
        installed: input.outcome.installed.filter(
          (packageName) => !invisible.has(packageName.toLowerCase()),
        ),
        failed: dedupe([...input.outcome.failed, ...stillMissing]),
      };
    });

  const install = (input: LatexPackageInstallInput) =>
    Effect.gen(function* () {
      const requested = dedupe(input.packages);
      // Names come out of a compiler transcript, and a transcript is written
      // by the document. Anything that is not a package name is answered here
      // rather than handed to `tlmgr` as argv, where a leading dash is an
      // option.
      const named = requested.filter((packageName) => PACKAGE_NAME_PATTERN.test(packageName));
      const rejected = requested.filter((packageName) => !PACKAGE_NAME_PATTERN.test(packageName));
      if (named.length === 0) return { installed: [], failed: rejected };

      const fetched = yield* installNamed({
        packages: named,
        binDirectory: input.binDirectory,
        timeout: input.timeout ?? INSTALL_TIMEOUT,
      });
      const outcome = yield* gateOnVisibility({
        outcome: fetched,
        expectedFiles: input.expectedFiles ?? [],
        binDirectory: input.binDirectory,
      });
      return rejected.length === 0
        ? outcome
        : { installed: outcome.installed, failed: [...outcome.failed, ...rejected] };
    });

  return LatexPackageInstaller.of({ install, unresolvedFiles });
});

export const layer = Layer.effect(LatexPackageInstaller, make).pipe(
  Layer.provide(ProcessRunner.layer),
  // The same port layer the build coordinator holds; Effect builds one
  // instance for the whole graph, so the server layer needs no adjustment.
  Layer.provide(LocalExecutionProcess.layer),
);
