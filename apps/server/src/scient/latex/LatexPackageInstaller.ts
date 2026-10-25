/**
 * Mutate only managed TeX, serializing tlmgr through one distribution permit. Use owned-tree
 * cancellation and prove retirement before release; unknown retirement quarantines work across
 * restart. Report ordinary fetch failures without replacing compiler errors, and installed only
 * when the engine sees the file.
 */
import { ExecutionRunId } from "@scientfactory/execution";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../../processRunner.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { latexEngineEnvironment } from "./latexCommand.ts";
import { makeLatexProcessRetirementMarkers } from "./latexProcessRetirement.ts";

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
    readonly install: (
      input: LatexPackageInstallInput,
    ) => Effect.Effect<LatexPackageInstallResult, PlatformError.PlatformError>;
    /**
     * Which of these files the engine cannot find. A probe that could not run
     * at all answers "found", because a distribution whose `kpsewhich` is
     * missing must not be one where nothing is ever visible.
     */
    readonly unresolvedFiles: (
      input: LatexFileVisibilityInput,
    ) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>;
  }
>()("t3/scient/latex/LatexPackageInstaller") {}

/**
 * Large collections need room for slow real downloads, but wedged fetches must remain bounded.
 * Budget expiry must retire the owned tree rather than leave an orphan completing behind a failed
 * build.
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
 * Cache repository-negative package names across saves so typos/private files do not trigger
 * repeated searches. Expire negatives quickly and clear after managed installation because
 * repository/distribution state can change.
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
 * tlmgr substring queries return longer filenames too. Match the exact shipped filename, not the
 * first package heading, or the download cannot repair the build.
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
 * Windows tlmgr.bat adds a shell and unsafe shim-only cancellation. Invoke bundled Perl/tlmgr.pl
 * directly with its bin/PERL5LIB setup; Scient never requests the shim's self-update path.
 * Elsewhere execute the script normally.
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
  const fileSystem = yield* FileSystem.FileSystem;
  const acquireProcessRetirementMarker = yield* makeLatexProcessRetirementMarkers;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  // `tlmgr` writes the distribution's own package database, so two runs
  // against one tree are a lock error at best. Every run below takes this.
  const tlmgrGate = yield* Semaphore.make(1);
  const unretiredDistributions = new Set<string>();
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
   * Lead PATH with the distribution's own bin and serialize its scripts. On timeout retain the
   * permit until retirement is proven; unknown outcomes preserve a durable marker and refuse
   * further mutation even after restart.
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
          const retirementMarker = path.join(input.binDirectory, ".scient-unretired-install");
          if (
            unretiredDistributions.has(input.binDirectory) ||
            (yield* fileSystem.exists(retirementMarker))
          )
            return yield* Effect.die(
              new Error(
                "The managed TeX distribution is quarantined because installer retirement is unknown.",
              ),
            );
          const invocation = texliveScriptInvocation({
            binDirectory: input.binDirectory,
            script: input.script,
            args: input.args,
            platform,
            join: (...segments) => path.join(...segments),
            dirname: (segment) => path.dirname(segment),
            pathDelimiter,
          });
          const runId = yield* nextRunId;
          const quarantine = Effect.sync(() => unretiredDistributions.add(input.binDirectory));
          const { handle } = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const settleRetirement = yield* acquireProcessRetirementMarker(
                retirementMarker,
                runId,
              );
              const handle = yield* processes
                .start({
                  runId,
                  executable: invocation.executable,
                  args: invocation.args,
                  cwd: input.binDirectory,
                  environment: scriptEnvironment(invocation),
                })
                .pipe(Effect.onError(() => quarantine));
              return { handle, settleRetirement };
            }).pipe(Effect.orDie),
            ({ handle, settleRetirement }) =>
              handle.cancel.pipe(
                Effect.andThen(handle.exitCode),
                Effect.andThen(settleRetirement),
                Effect.onError(() => quarantine),
                Effect.orDie,
              ),
          );
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
          // The finalizer must prove retirement before clearing the marker.
          if (Option.isNone(exitCode)) yield* handle.cancel;
          yield* Fiber.join(outputFiber).pipe(
            Effect.timeoutOption("2 seconds"),
            Effect.ignoreCause(),
          );
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
   * One kpsewhich resolves a whole ordered list, leaving missing names blank. Batch probes before
   * each compile to avoid a process-spawn cost per preamble package.
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

  const unresolvedFiles = Effect.fn("LatexPackageInstaller.unresolvedFiles")(
    function* (input: LatexFileVisibilityInput) {
      if (input.binDirectory.length === 0) return [];
      if (
        unretiredDistributions.has(input.binDirectory) ||
        (yield* fileSystem.exists(path.join(input.binDirectory, ".scient-unretired-install")))
      )
        return yield* Effect.die(
          new Error(
            "The managed TeX distribution cannot be inspected while installer retirement is unknown.",
          ),
        );
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
    },
    (effect) => effect.pipe(tlmgrGate.withPermits(1)),
  );

  /** Maps a missing file back to the package that ships it. Costs one query. */
  const searchOwningPackage = Effect.fn("LatexPackageInstaller.searchOwningPackage")(
    function* (input: { readonly binDirectory: string; readonly packageName: string }) {
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
    },
  );

  /** The fetch itself, over names already deduplicated and checked. */
  const installNamed = Effect.fn("LatexPackageInstaller.installNamed")(function* (input: {
    readonly packages: ReadonlyArray<string>;
    readonly binDirectory: string;
    readonly timeout: Duration.Input;
  }) {
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
   * tlmgr can unpack before its ls-R index is rebuilt. Probe with kpsewhich, rebuild the index once
   * if needed, and report installed only files the engine can actually resolve; invisible files
   * remain failed names.
   */
  const gateOnVisibility = Effect.fn("LatexPackageInstaller.gateOnVisibility")(function* (input: {
    readonly outcome: LatexPackageInstallResult;
    readonly expectedFiles: ReadonlyArray<string>;
    readonly binDirectory: string;
  }) {
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

  const install = Effect.fn("LatexPackageInstaller.install")(function* (
    input: LatexPackageInstallInput,
  ) {
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
