// @effect-diagnostics nodeBuiltinImport:off -- Content identities guard incremental preview builds.
import * as NodeCrypto from "node:crypto";
import type { ScientLatexArtworkResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

const maximumWorkspaces = 8;
const maximumWorkspaceBytes = 16_000_000n;
const maximumInputBytes = 32_000_000n;
const maximumEntries = 2048;

export function latexArtworkWorkspaceKey(parts: readonly string[]): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part);
  return hash.digest("hex");
}

type Workspace = {
  directory: string;
  scope: Scope.Closeable;
  gate: Semaphore.Semaphore;
  users: number;
  retained: boolean;
  fingerprint: string | null;
};

/** Retain build state, never unchecked PDF responses. Every request still runs the driver. */
export const makeLatexArtworkWorkspaces = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const admission = yield* Semaphore.make(1);
  const workspaces = new Map<string, Workspace>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(workspaces.values(), (entry) => Scope.close(entry.scope, Exit.void)),
  );

  // Include directory names so adding a local package/data file cannot silently
  // change TeX's search resolution while its previous dependencies stay intact.
  const treeIdentity = Effect.fnUntraced(function* (root: string) {
    const pending = [root];
    const names: string[] = [];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const name of (yield* fs.readDirectory(directory)).sort()) {
        const target = path.join(directory, name);
        const info = yield* fs.stat(target);
        const real = yield* fs.realPath(target);
        // Following an unbounded linked tree would make validation itself a stall.
        const relative = path.relative(root, real);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return null;
        names.push(`${path.relative(root, target)}:${info.type}:${real}`);
        if (names.length > maximumEntries) return null;
        if (info.type === "Directory") {
          if (pending.includes(real) || names.includes(`directory:${real}`)) return null;
          names.push(`directory:${real}`);
          pending.push(real);
        }
      }
    }
    return names.sort();
  });

  const fingerprint = (directory: string, root: string, tracked: readonly string[]) =>
    Effect.gen(function* () {
      const tree = yield* treeIdentity(root);
      if (tree === null) return null;
      const recorderPath = path.join(directory, "picture.fls");
      if ((yield* fs.stat(recorderPath)).size > 1_000_000n) return null;
      const recorder = yield* fs.readFileString(recorderPath);
      const canonicalDirectory = yield* fs.realPath(directory);
      const inputs = new Set(tracked);
      let cwd = directory;
      let hasRoot = false;
      for (const line of recorder.split(/\r?\n/u)) {
        if (line.startsWith("PWD ")) cwd = line.slice(4);
        if (!line.startsWith("INPUT ")) continue;
        const input = path.resolve(cwd, line.slice(6));
        const relative = path.relative(canonicalDirectory, yield* fs.realPath(input));
        if (relative === "picture.tex") hasRoot = true;
        // Aux files produced by this run are build state, not independent inputs.
        if (
          relative !== "picture.tex" &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        )
          continue;
        inputs.add(input);
        if (inputs.size > maximumEntries) return null;
      }
      if (!hasRoot) return null;
      const hash = NodeCrypto.createHash("sha256").update(latexArtworkWorkspaceKey(tree));
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
      }
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

  const acquire = (key: string, parent: string) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        let entry = workspaces.get(key);
        if (!entry) {
          while (workspaces.size >= maximumWorkspaces) {
            const idle = [...workspaces.entries()].find(([, item]) => item.users === 0);
            if (!idle) break;
            workspaces.delete(idle[0]);
            yield* Scope.close(idle[1].scope, Exit.void);
          }
          const scope = yield* Scope.make();
          const directory = yield* fs.makeTempDirectoryScoped({ directory: parent }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          entry = {
            directory,
            scope,
            gate: yield* Semaphore.make(1),
            users: 0,
            retained: false,
            fingerprint: null,
          };
          workspaces.set(key, entry);
        } else {
          workspaces.delete(key);
          workspaces.set(key, entry);
        }
        entry.users++;
        return entry;
      }),
    );

  const release = (key: string, entry: Workspace) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        entry.users--;
        if (entry.users === 0 && (!entry.retained || workspaces.size > maximumWorkspaces)) {
          if (workspaces.get(key) === entry) workspaces.delete(key);
          yield* Scope.close(entry.scope, Exit.void);
        }
      }),
    );

  return <E, R>(options: {
    key: string;
    parent: string;
    workspaceRoot: string;
    trackedInputs: readonly string[];
    run: (
      directory: string,
      forceReprocess: boolean,
    ) => Effect.Effect<ScientLatexArtworkResult, E, R>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* Effect.acquireRelease(acquire(options.key, options.parent), (entry) =>
          release(options.key, entry),
        );
        return yield* entry.gate.withPermits(1)(
          Effect.gen(function* () {
            const before = entry.retained
              ? yield* fingerprint(entry.directory, options.workspaceRoot, options.trackedInputs)
              : null;
            const force = before === null || before !== entry.fingerprint;
            entry.retained = false;
            const result = yield* options.run(entry.directory, force);
            if (result._tag === "ready" && (yield* withinSizeLimit(entry.directory))) {
              entry.fingerprint = yield* fingerprint(
                entry.directory,
                options.workspaceRoot,
                options.trackedInputs,
              );
              entry.retained = entry.fingerprint !== null;
            }
            return result;
          }),
        );
      }),
    );
});
