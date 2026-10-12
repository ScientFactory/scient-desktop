// @effect-diagnostics nodeBuiltinImport:off -- Content identities and owner PIDs guard private preview state.
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import type { ScientLatexArtworkResult } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

const maximumWorkspaces = 8;
const maximumWorkspaceBytes = 16_000_000n;
const maximumInputBytes = 32_000_000n;
const maximumEntries = 2048;
const ownerFileName = ".scient-artwork-owner.json";
const directoryPrefix = "scient-artwork-";
const Owner = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literal("scient-latex-artwork"),
    version: Schema.Literal(1),
    instance: Schema.String.check(
      Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
    ),
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    directory: Schema.NonEmptyString,
    host: Schema.NonEmptyString,
    retirement: Schema.Literals(["settled", "active", "unresolved"]),
  }),
);
const decodeOwner = Schema.decodeUnknownEffect(Owner);
const encodeOwner = Schema.encodeSync(Owner);

const ownerAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors and recycled PIDs are not evidence of an orphan.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export function latexArtworkWorkspaceKey(parts: readonly string[]): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part);
  return hash.digest("hex");
}

type Workspace = {
  directory: string | null;
  scope: Scope.Closeable | null;
  gate: Semaphore.Semaphore;
  users: number;
  retained: boolean;
  fingerprint: string | null;
  quarantined: boolean;
};

/** Retain build state, never unchecked PDF responses. Every request still runs the driver. */
export const makeLatexArtworkWorkspaces = Effect.fnUntraced(function* (parent: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  yield* fs.makeDirectory(parent, { recursive: true });
  const canonicalParent = yield* fs.realPath(parent);
  const instance = NodeCrypto.randomUUID();
  const host = NodeOs.hostname();
  const admission = yield* Semaphore.make(1);
  const operations = yield* Scope.make();
  const workspaces = new Map<string, Workspace>();

  const retire = Effect.fnUntraced(function* (entry: Workspace) {
    if (entry.quarantined) return;
    const scope = entry.scope;
    entry.scope = null;
    entry.directory = null;
    entry.retained = false;
    entry.fingerprint = null;
    if (scope) yield* Scope.close(scope, Exit.void);
  });
  yield* Effect.addFinalizer(() =>
    Scope.close(operations, Exit.void).pipe(
      Effect.ensuring(
        admission.withPermits(1)(
          Effect.forEach(workspaces.values(), retire).pipe(
            Effect.ensuring(Effect.sync(() => workspaces.clear())),
          ),
        ),
      ),
    ),
  );

  // Random names alone prove no ownership. Legacy/unmarked directories and every
  // live or uncertain PID remain untouched, including another layer in this process.
  for (const name of (yield* fs.readDirectory(canonicalParent))
    .filter((name) => name.startsWith(directoryPrefix))
    .sort()
    .slice(0, maximumEntries)) {
    yield* Effect.gen(function* () {
      const directory = path.join(canonicalParent, name);
      if ((yield* fs.realPath(directory)) !== directory) return;
      if ((yield* fs.stat(directory)).type !== "Directory") return;
      const marker = path.join(directory, ownerFileName);
      if ((yield* fs.realPath(marker)) !== marker) return;
      const info = yield* fs.stat(marker);
      if (info.type !== "File" || info.size > 4096n) return;
      const text = yield* fs.readFileString(marker);
      const owner = yield* decodeOwner(text);
      if (
        owner.directory !== directory ||
        !name.startsWith(`${directoryPrefix}${owner.instance}-`) ||
        owner.host !== host ||
        owner.retirement !== "settled" ||
        ownerAlive(owner.pid)
      )
        return;
      // Recheck the lease and containment immediately before deletion; collectors
      // may race each other, but none adopts a previous instance's directory.
      if ((yield* fs.realPath(directory)) !== directory) return;
      if ((yield* fs.readFileString(marker)) !== text || ownerAlive(owner.pid)) return;
      yield* fs.remove(directory, { recursive: true, force: true });
    }).pipe(Effect.ignore);
  }

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  const fingerprint = (
    directory: string,
    searchPath: string | null,
    pathDelimiter: string,
    tracked: readonly string[],
  ) =>
    Effect.gen(function* () {
      if (searchPath === null || (pathDelimiter !== ":" && pathDelimiter !== ";")) return null;
      const canonicalDirectory = yield* fs.realPath(directory);
      const roots = new Set([canonicalDirectory]);
      for (const entry of searchPath.split(pathDelimiter)) {
        // The raw environment does not expose the distribution's default paths
        // or their negative lookups. Never treat an empty component as evidence.
        if (!entry) return null;
        const value = entry.replace(/^!!/u, "").replaceAll("\\", "/");
        // Recursive/default/dynamic search cannot be proved from a recorder.
        // Force the driver instead of walking an entire workspace or TeX tree.
        if (/[$%~{}*?]/u.test(value) || value.includes("//")) return null;
        const root = path.resolve(directory, value);
        roots.add(root);
        if (roots.size > maximumEntries) return null;
      }
      const recorderPath = path.join(directory, "picture.fls");
      if ((yield* fs.stat(recorderPath)).size > 1_000_000n) return null;
      const recorder = yield* fs.readFileString(recorderPath);
      const inputs = new Set(tracked);
      let cwd = directory;
      let hasRoot = false;
      for (const line of recorder.split(/\r?\n/u)) {
        if (line.startsWith("PWD ")) {
          cwd = line.slice(4);
          if (!path.isAbsolute(cwd)) return null;
        }
        if (!line.startsWith("INPUT ")) continue;
        const input = path.resolve(cwd, line.slice(6));
        const real = yield* fs.realPath(input);
        if (real === path.join(canonicalDirectory, "picture.tex")) hasRoot = true;
        // Aux files produced by this run are build state, not independent inputs.
        if (
          real !== path.join(canonicalDirectory, "picture.tex") &&
          inside(canonicalDirectory, real)
        )
          continue;
        inputs.add(input);
        if (inputs.size > maximumEntries) return null;
      }
      if (!hasRoot) return null;

      const hash = NodeCrypto.createHash("sha256");
      const names = new Map<string, string>();
      const candidates = new Set<string>();
      for (const input of inputs) {
        if (inside(canonicalDirectory, input)) continue;
        // Recorder paths can be absolute even for a request such as sub/data.dat.
        // Check every possible suffix, not just the basename, against the actual
        // search roots so a newly shadowing local package or data path is noticed.
        let suffix = path.basename(input);
        let ancestor = path.dirname(input);
        for (;;) {
          for (const root of roots.keys()) candidates.add(path.join(root, suffix));
          if (candidates.size > maximumEntries) return null;
          const next = path.dirname(ancestor);
          if (next === ancestor) break;
          suffix = path.join(path.basename(ancestor), suffix);
          ancestor = next;
        }
      }

      let bytes = 0n;
      for (const input of [...inputs].sort()) {
        const real = yield* fs.realPath(input);
        const before = yield* fs.stat(real);
        if (before.type !== "File") return null;
        bytes += before.size;
        if (bytes > maximumInputBytes) return null;
        const data = yield* fs.readFile(real);
        const after = yield* fs.stat(real);
        if (
          data.byteLength !== Number(before.size) ||
          after.size !== before.size ||
          Option.getOrNull(after.mtime)?.getTime() !== Option.getOrNull(before.mtime)?.getTime()
        )
          return null;
        hash
          .update(
            latexArtworkWorkspaceKey([
              input,
              real,
              before.size.toString(),
              String(Option.getOrNull(before.mtime)?.getTime()),
            ]),
          )
          .update(`${data.byteLength}:`)
          .update(data);
        const containsZero = data.includes(0);
        if (containsZero && /\.(?:tex|sty|cls|def|cfg|ltx|fd)$/iu.test(input)) return null;
        if (data.includes(92) && !containsZero) {
          const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            .toString("utf8")
            .replace(/(?<!\\)%[^\r\n]*/gu, "");
          // The recorder contains successful reads, not negative lookups. Literal
          // filenames identify relevant candidate names; expansion, primitive
          // streams, Lua and computed commands cannot supply that proof.
          if (
            /\\(?:openin|openout|directlua|csname|catcode|scantokens|addplot|graphicspath|DeclareGraphicsExtensions)\b/u.test(
              text,
            )
          )
            return null;
          const lookups =
            /\\(input|include|IfFileExists|InputIfFileExists|includegraphics|pgfplotstableread|pgfplotstabletypeset|documentclass|usepackage|RequirePackage|LoadClass)\b/gu;
          for (const lookup of text.matchAll(lookups)) {
            const argument = /^(?:\s*\[[^\]]*\])?\s*(?:\{([^{}]*)\}|([^\s{}]+))/u.exec(
              text.slice(lookup.index + lookup[0].length),
            );
            const fileName = argument?.[1] ?? argument?.[2];
            if (!fileName || /[\\#$%{}~"]/u.test(fileName)) return null;
            for (const rawName of fileName.split(",")) {
              const name = rawName.trim();
              if (!name) return null;
              const command = lookup[1];
              if (command === "includegraphics" && !path.extname(name)) return null;
              const extension =
                command === "documentclass" || command === "LoadClass"
                  ? ".cls"
                  : command === "usepackage" || command === "RequirePackage"
                    ? ".sty"
                    : ".tex";
              for (const root of roots) {
                const requested = path.resolve(root, name);
                if (requested === root) return null;
                if (!path.isAbsolute(name) && !inside(root, requested)) return null;
                candidates.add(requested);
                if (!path.extname(name)) candidates.add(`${requested}${extension}`);
                if (candidates.size > maximumEntries) return null;
              }
            }
          }
        }
      }
      for (const candidate of [...candidates].sort()) {
        if (names.has(candidate)) continue;
        if (yield* fs.exists(candidate)) {
          const info = yield* fs.stat(candidate);
          names.set(candidate, `${info.type}:${yield* fs.realPath(candidate)}`);
        } else {
          names.set(candidate, "missing");
        }
        if (names.size > maximumEntries) return null;
      }
      hash.update(
        latexArtworkWorkspaceKey(
          [...names].sort(([left], [right]) => left.localeCompare(right)).flat(),
        ),
      );
      return hash.digest("hex");
    }).pipe(Effect.orElseSucceed(() => null));

  const withinSizeLimit = (directory: string) =>
    Effect.gen(function* () {
      let size = 0n;
      for (const name of yield* fs.readDirectory(directory)) {
        const info = yield* fs.stat(path.join(directory, name));
        if (info.type !== "File") return false;
        size += info.size;
        if (size > maximumWorkspaceBytes) return false;
      }
      return true;
    }).pipe(Effect.orElseSucceed(() => false));

  const reserve = (key: string) =>
    admission.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          let entry = workspaces.get(key);
          if (!entry) {
            while (workspaces.size >= maximumWorkspaces) {
              const idle = [...workspaces.entries()].find(
                ([, item]) => item.users === 0 && !item.quarantined,
              );
              if (!idle) return null;
              yield* retire(idle[1]);
              workspaces.delete(idle[0]);
            }
            entry = {
              directory: null,
              scope: null,
              gate: yield* Semaphore.make(1),
              users: 0,
              retained: false,
              fingerprint: null,
              quarantined: false,
            };
          } else {
            workspaces.delete(key);
          }
          workspaces.set(key, entry);
          entry.users++;
          const reserved = entry;
          yield* Effect.addFinalizer(() =>
            admission.withPermits(1)(
              Effect.gen(function* () {
                reserved.users--;
                if (
                  reserved.users === 0 &&
                  !reserved.quarantined &&
                  (!reserved.retained || workspaces.size > maximumWorkspaces)
                ) {
                  yield* retire(reserved);
                  if (workspaces.get(key) === reserved) workspaces.delete(key);
                }
              }),
            ),
          );
          return entry;
        }),
      ),
    );

  const writeOwner = (directory: string, retirement: "settled" | "active" | "unresolved") =>
    Effect.scoped(
      Effect.gen(function* () {
        const marker = yield* fs.open(path.join(directory, ownerFileName), {
          flag: "w",
          mode: 0o600,
        });
        yield* marker.writeAll(
          Buffer.from(
            encodeOwner({
              kind: "scient-latex-artwork",
              version: 1,
              instance,
              pid: process.pid,
              directory,
              host,
              retirement,
            }),
          ),
        );
        yield* marker.sync;
        if (platform !== "win32") {
          const parent = yield* fs.open(directory, { flag: "r" });
          yield* parent.sync;
        }
      }),
    );

  const ensureDirectory = Effect.fnUntraced(function* (entry: Workspace) {
    if (entry.directory !== null) return entry.directory;
    const scope = yield* Scope.make();
    return yield* Effect.gen(function* () {
      const directory = yield* fs
        .makeTempDirectoryScoped({
          directory: canonicalParent,
          prefix: `${directoryPrefix}${instance}-`,
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const canonical = yield* fs.realPath(directory);
      yield* writeOwner(canonical, "settled");
      entry.directory = canonical;
      entry.scope = scope;
      return canonical;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  });

  return <E, R>(options: {
    key: string;
    searchPath: string | null;
    pathDelimiter: string;
    trackedInputs: readonly string[];
    run: (
      directory: string,
      forceReprocess: boolean,
      onRetirementFailure: Effect.Effect<void>,
    ) => Effect.Effect<ScientLatexArtworkResult, E, R>;
  }) => {
    const operation = Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* reserve(options.key);
        if (entry === null)
          return {
            _tag: "unavailable" as const,
            message: "Drawing workspace capacity is held by active or quarantined processes.",
          };
        return yield* entry.gate.withPermits(1)(
          Effect.gen(function* () {
            if (entry.quarantined)
              return {
                _tag: "unavailable" as const,
                message: "The drawing workspace has an unretired process and cannot be reused.",
              };
            const retained = entry.retained;
            entry.retained = false;
            const directory = yield* ensureDirectory(entry).pipe(Effect.uninterruptible);
            const before = retained
              ? yield* fingerprint(
                  directory,
                  options.searchPath,
                  options.pathDelimiter,
                  options.trackedInputs,
                )
              : null;
            const force = before === null || before !== entry.fingerprint;
            // Finalizers registered by the driver (processes, output fibers, etc.)
            // retire before hashing or releasing the reusable directory's permit.
            yield* writeOwner(directory, "active");
            const onRetirementFailure = Effect.sync(() => {
              entry.quarantined = true;
              entry.retained = false;
            }).pipe(Effect.andThen(writeOwner(directory, "unresolved")), Effect.orDie);
            const result = yield* Effect.scoped(options.run(directory, force, onRetirementFailure));
            if (entry.quarantined)
              return {
                _tag: "unavailable" as const,
                message: "The drawing process did not retire; its workspace has been quarantined.",
              };
            yield* writeOwner(directory, "settled");
            if (result._tag === "ready" && (yield* withinSizeLimit(directory))) {
              entry.fingerprint = yield* fingerprint(
                directory,
                options.searchPath,
                options.pathDelimiter,
                options.trackedInputs,
              );
              // Unknown evidence forces the next driver pass, but does not make
              // safely retired, bounded aux state unsafe to keep.
              entry.retained = true;
            }
            return result;
          }).pipe(Effect.onExit(() => (entry.retained ? Effect.void : retire(entry)))),
        );
      }),
    );
    // Service shutdown interrupts and joins uses before deleting retained state.
    // Caller cancellation likewise joins its owned operation, not merely its wait.
    return Effect.acquireUseRelease(
      Effect.forkIn(operation, operations, { uninterruptible: false }),
      Fiber.join,
      (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    );
  };
});
