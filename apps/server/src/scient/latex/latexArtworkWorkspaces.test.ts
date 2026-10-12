// @effect-diagnostics nodeBuiltinImport:off -- Orphan fixtures exercise host PID ownership without signaling processes.
import * as NodeOs from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { latexArtworkWorkspaceKey, makeLatexArtworkWorkspaces } from "./latexArtworkWorkspaces.ts";

const pathDelimiter = process.platform === "win32" ? ";" : ":";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const main = path.join(root, "main.tex");
  const data = path.join(root, "data.tex");
  yield* fs.writeFileString(main, "\\documentclass{article}");
  yield* fs.writeFileString(data, "aaaa");
  const use = yield* makeLatexArtworkWorkspaces(parent);
  const runs: Array<{ directory: string; force: boolean }> = [];
  const build = (directory: string, force: boolean) =>
    Effect.gen(function* () {
      runs.push({ directory, force });
      const source = path.join(directory, "picture.tex");
      if (!(yield* fs.exists(source))) yield* fs.writeFileString(source, "Picture");
      yield* fs.writeFileString(
        path.join(directory, "picture.fls"),
        `PWD ${directory}\nINPUT ${source}\nINPUT ${data}\nOUTPUT ${path.join(directory, "picture.pdf")}\n`,
      );
      yield* fs.writeFileString(path.join(directory, "picture.pdf"), "Synthetic PDF");
      return { _tag: "ready" as const, pdfBase64: "synthetic" };
    });
  const run = (key = "picture") =>
    use({
      key,
      searchPath: root,
      pathDelimiter,
      trackedInputs: [main],
      run: build,
    });
  return { fs, path, root, parent, main, data, use, runs, run, build };
});

it("keeps distinct request fields distinct in the workspace identity", () => {
  expect(latexArtworkWorkspaceKey(["a", "bc"])).not.toBe(latexArtworkWorkspaceKey(["ab", "c"]));
  expect(latexArtworkWorkspaceKey(["a", "bc"])).toBe(latexArtworkWorkspaceKey(["a", "bc"]));
});

it.effect("reuses build state but invokes the driver again on every request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run();
      yield* f.run();
      expect(f.runs.map((run) => run.force)).toEqual([true, false]);
      expect(f.runs[0]!.directory).toBe(f.runs[1]!.directory);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("forces a rebuild for changed bytes even when length and mtime are restored", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run();
      const info = yield* f.fs.stat(f.data);
      yield* f.fs.writeFileString(f.data, "bbbb");
      yield* f.fs.utimes(f.data, Option.getOrThrow(info.atime), Option.getOrThrow(info.mtime));
      yield* f.run();
      expect(f.runs.map((run) => run.force)).toEqual([true, true]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("forces a rebuild when a requested class acquires a local shadow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run();
      yield* f.fs.writeFileString(f.path.join(f.root, "article.cls"), "New local package");
      yield* f.run();
      expect(f.runs.map((run) => run.force)).toEqual([true, true]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discards failed and interrupted builds before another request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run();
      const old = f.runs[0]!.directory;
      yield* f.use({
        key: "picture",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: () => Effect.succeed({ _tag: "unavailable" as const, message: "Failure" }),
      });
      expect(yield* f.fs.exists(old)).toBe(false);
      const entered = yield* Deferred.make<void>();
      let interruptedDirectory = "";
      const fiber = yield* f
        .use({
          key: "picture",
          searchPath: f.root,
          pathDelimiter,
          trackedInputs: [f.main],
          run: (directory) =>
            Effect.gen(function* () {
              interruptedDirectory = directory;
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(yield* f.fs.exists(interruptedDirectory)).toBe(false);
      yield* f.run();
      expect(f.runs.at(-1)!.force).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("evicts old idle directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 10; index++) yield* f.run(`picture-${index}`);
      expect(yield* f.fs.exists(f.runs[0]!.directory)).toBe(false);
      expect(yield* f.fs.exists(f.runs.at(-1)!.directory)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("serializes requests for the same workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let calls = 0;
      const run = (directory: string, force: boolean) =>
        Effect.gen(function* () {
          calls++;
          if (calls === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
          }
          return yield* f.build(directory, force);
        });
      const options = {
        key: "picture",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run,
      };
      const first = yield* f.use(options).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const second = yield* f.use(options).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(calls).toBe(1);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(calls).toBe(2);
      expect(f.runs.map((run) => run.force)).toEqual([true, false]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("removes retained directories when the service scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let retained = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const use = yield* makeLatexArtworkWorkspaces(f.parent);
          yield* use({
            key: "picture",
            searchPath: f.root,
            pathDelimiter,
            trackedInputs: [f.main],
            run: (directory, force) => {
              retained = directory;
              return f.build(directory, force);
            },
          });
          expect(yield* f.fs.exists(retained)).toBe(true);
        }),
      );
      expect(yield* f.fs.exists(f.parent)).toBe(true);
      expect(yield* f.fs.exists(retained)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps bounded aux state but forces reprocessing without a complete recorder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let directory = "";
      yield* f.use({
        key: "picture",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (target, force) =>
          Effect.gen(function* () {
            directory = target;
            const result = yield* f.build(target, force);
            yield* f.fs.writeFileString(f.path.join(target, "picture.fls"), "INPUT unknown\n");
            return result;
          }),
      });
      expect(yield* f.fs.exists(directory)).toBe(true);
      yield* f.run();
      expect(f.runs.at(-1)!.force).toBe(true);
      expect(f.runs.at(-1)!.directory).toBe(directory);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("checks recorded package inputs outside the project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const packageFile = f.path.join(f.parent, "package.sty");
      yield* f.fs.writeFileString(packageFile, "Package version one");
      const run = (directory: string, force: boolean) =>
        Effect.gen(function* () {
          const result = yield* f.build(directory, force);
          const recorder = f.path.join(directory, "picture.fls");
          yield* f.fs.writeFileString(
            recorder,
            (yield* f.fs.readFileString(recorder)) + `INPUT ${packageFile}\n`,
          );
          return result;
        });
      const options = {
        key: "picture",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run,
      };
      yield* f.use(options);
      yield* f.use(options);
      yield* f.fs.writeFileString(packageFile, "Package version two");
      yield* f.use(options);
      expect(f.runs.map((run) => run.force)).toEqual([true, false, true]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discards directories exceeding the retained disk limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let directory = "";
      yield* f.use({
        key: "picture",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (target, force) =>
          Effect.gen(function* () {
            directory = target;
            const result = yield* f.build(target, force);
            yield* f.fs.writeFile(f.path.join(target, "large.bin"), new Uint8Array(16_000_001));
            return result;
          }),
      });
      expect(yield* f.fs.exists(directory)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reuses aux state despite thousands of unrelated project files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const trees = [".git/objects", "node_modules/package", "build/output"];
      for (const tree of trees)
        yield* f.fs.makeDirectory(f.path.join(f.root, tree), { recursive: true });
      yield* Effect.forEach(
        Array.from({ length: 2100 }, (_, index) => index),
        (index) => f.fs.writeFileString(f.path.join(f.root, `unrelated-${index}`), "unrelated"),
        { concurrency: 32 },
      );
      const options = {
        key: "large-project",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (directory: string, force: boolean) =>
          Effect.gen(function* () {
            const aux = f.path.join(directory, "picture.aux");
            if (f.runs.length === 0) yield* f.fs.writeFileString(aux, "Retained labels");
            else expect(yield* f.fs.readFileString(aux)).toBe("Retained labels");
            return yield* f.build(directory, force);
          }),
      };
      yield* f.use(options);
      yield* f.fs.writeFileString(f.path.join(f.root, "build/output/unrelated-0"), "changed");
      yield* f.use(options);
      expect(f.runs.map((run) => run.force)).toEqual([true, false]);
      expect(f.runs[1]!.directory).toBe(f.runs[0]!.directory);
      // Recursive search has unknown negative resolution evidence. It forces
      // another driver pass without walking these unrelated trees.
      let recursiveDirectory = "";
      yield* f.use({
        ...options,
        key: "recursive-search",
        searchPath: `${f.root}//`,
        run: (directory, force) => {
          recursiveDirectory = directory;
          return f.build(directory, force);
        },
      });
      expect(yield* f.fs.exists(recursiveDirectory)).toBe(true);
      yield* f.use({
        ...options,
        key: "recursive-search",
        searchPath: `${f.root}//`,
        run: f.build,
      });
      expect(f.runs.at(-1)!.directory).toBe(recursiveDirectory);
      expect(f.runs.at(-1)!.force).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("invalidates nested local shadows of an unchanged recorded data dependency", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const distribution = f.path.join(f.parent, "distribution");
      yield* f.fs.makeDirectory(f.path.join(distribution, "plots"), { recursive: true });
      const external = f.path.join(distribution, "plots/series.dat");
      yield* f.fs.writeFileString(external, "Original external data");
      const options = {
        key: "nested-data",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (directory: string, force: boolean) =>
          Effect.gen(function* () {
            const result = yield* f.build(directory, force);
            const recorder = f.path.join(directory, "picture.fls");
            yield* f.fs.writeFileString(
              recorder,
              (yield* f.fs.readFileString(recorder)) + `INPUT ${external}\n`,
            );
            return result;
          }),
      };
      yield* f.use(options);
      yield* f.use(options);
      yield* f.fs.makeDirectory(f.path.join(f.root, "plots"), { recursive: true });
      yield* f.fs.writeFileString(f.path.join(f.root, "plots/series.dat"), "New local shadow");
      yield* f.use(options);
      expect(yield* f.fs.readFileString(external)).toBe("Original external data");
      expect(f.runs.map((run) => run.force)).toEqual([true, false, true]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("forces reprocessing but retains bounded aux for unverifiable search configuration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let directory = "";
      yield* f.use({
        key: "dynamic-search",
        searchPath: "$TEXMFLOCAL/tex//:",
        pathDelimiter,
        trackedInputs: [f.main],
        run: (target, force) => {
          directory = target;
          return f.build(target, force);
        },
      });
      expect(yield* f.fs.exists(directory)).toBe(true);
      yield* f.use({
        key: "dynamic-search",
        searchPath: "$TEXMFLOCAL/tex//:",
        pathDelimiter,
        trackedInputs: [f.main],
        run: f.build,
      });
      expect(f.runs.at(-1)!.directory).toBe(directory);
      expect(f.runs.at(-1)!.force).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("holds the directory until cancelled run finalizers retire before queued B", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const retiring = yield* Deferred.make<void>();
      const finishRetirement = yield* Deferred.make<void>();
      const successorEntered = yield* Deferred.make<void>();
      let oldDirectory = "";
      let successorDirectory = "";
      const options = {
        key: "picture",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
      };
      const first = yield* f
        .use({
          ...options,
          run: (directory, force) =>
            Effect.gen(function* () {
              oldDirectory = directory;
              yield* f.build(directory, force);
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(retiring, undefined);
                  yield* Deferred.await(finishRetirement);
                  yield* f.fs.remove(f.path.join(directory, "picture.pdf"), { force: true });
                }).pipe(Effect.orDie),
              );
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const second = yield* f
        .use({
          ...options,
          run: (directory, force) =>
            Effect.gen(function* () {
              successorDirectory = directory;
              yield* Deferred.succeed(successorEntered, undefined);
              return yield* f.build(directory, force);
            }),
        })
        .pipe(Effect.forkScoped);
      const cancellation = yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
      yield* Deferred.await(retiring);
      expect(yield* Deferred.isDone(successorEntered)).toBe(false);
      expect(yield* f.fs.exists(oldDirectory)).toBe(true);
      yield* Deferred.succeed(finishRetirement, undefined);
      yield* Fiber.join(cancellation);
      yield* Fiber.join(second);
      expect(successorDirectory).not.toBe(oldDirectory);
      expect(yield* f.fs.exists(oldDirectory)).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(successorDirectory, "picture.pdf"))).toBe(
        "Synthetic PDF",
      );
      yield* f.run();
      expect(f.runs.at(-1)!.directory).toBe(successorDirectory);
      expect(f.runs.at(-1)!.force).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fingerprints only after successful run-scoped finalizers finish", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.use({
        key: "picture",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (directory, force) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              f.fs.writeFileString(f.data, "bbbb").pipe(Effect.orDie),
            );
            return yield* f.build(directory, force);
          }),
      });
      yield* f.run();
      expect(f.runs.map((run) => run.force)).toEqual([true, false]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retires interrupted preflight hashing before admitting a successor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const hashing = yield* Deferred.make<void>();
      let blockHash = false;
      const fileSystem = FileSystem.FileSystem.of({
        ...f.fs,
        readFile: (target) =>
          target === f.data && blockHash
            ? Deferred.succeed(hashing, undefined).pipe(Effect.andThen(Effect.never))
            : f.fs.readFile(target),
      });
      const use = yield* makeLatexArtworkWorkspaces(f.parent).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const options = {
        key: "hashing",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: f.build,
      };
      yield* use(options);
      const oldDirectory = f.runs[0]!.directory;
      blockHash = true;
      const first = yield* use(options).pipe(Effect.forkScoped);
      yield* Deferred.await(hashing);
      blockHash = false;
      const second = yield* use(options).pipe(Effect.forkScoped);
      yield* Fiber.interrupt(first);
      yield* Fiber.join(second);
      expect(yield* f.fs.exists(oldDirectory)).toBe(false);
      expect(f.runs.at(-1)!.directory).not.toBe(oldDirectory);
      expect(f.runs.at(-1)!.force).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("closes a temporary scope if acquisition is interrupted before publication", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const allocated = yield* Deferred.make<void>();
      const publish = yield* Deferred.make<void>();
      let directory = "";
      const fileSystem = FileSystem.FileSystem.of({
        ...f.fs,
        makeTempDirectoryScoped: (options) =>
          Effect.gen(function* () {
            directory = yield* f.fs.makeTempDirectoryScoped(options);
            yield* Deferred.succeed(allocated, undefined);
            yield* Deferred.await(publish);
            return directory;
          }),
      });
      const use = yield* makeLatexArtworkWorkspaces(f.parent).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const first = yield* use({
        key: "acquiring",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: f.build,
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(allocated);
      const cancellation = yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(yield* f.fs.exists(directory)).toBe(true);
      yield* Deferred.succeed(publish, undefined);
      yield* Fiber.join(cancellation);
      expect(yield* f.fs.exists(directory)).toBe(false);
      expect(f.runs).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("joins service-owned active work before removing its directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const use = yield* makeLatexArtworkWorkspaces(f.parent).pipe(
        Effect.provideService(Scope.Scope, serviceScope),
      );
      const entered = yield* Deferred.make<void>();
      const retiring = yield* Deferred.make<void>();
      const retired = yield* Deferred.make<void>();
      let directory = "";
      const request = yield* use({
        key: "service-shutdown",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (target, force) =>
          Effect.gen(function* () {
            directory = target;
            yield* f.build(target, force);
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(retiring, undefined).pipe(Effect.andThen(Deferred.await(retired))),
            );
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const closing = yield* Scope.close(serviceScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(retiring);
      expect(yield* f.fs.exists(directory)).toBe(true);
      yield* Deferred.succeed(retired, undefined);
      yield* Fiber.join(closing);
      expect(yield* f.fs.exists(directory)).toBe(false);
      yield* Fiber.interrupt(request);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "startup reclaims proven dead owners while preserving live, unknown and escaping directories",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run();
        const live = f.runs[0]!.directory;
        const instance = "12345678-1234-1234-1234-123456789abc";
        const canonicalParent = yield* f.fs.realPath(f.parent);
        const dead = f.path.join(canonicalParent, `scient-artwork-${instance}-dead`);
        const unknown = f.path.join(canonicalParent, `scient-artwork-${instance}-unmarked`);
        const malformed = f.path.join(canonicalParent, `scient-artwork-${instance}-malformed`);
        const active = f.path.join(canonicalParent, `scient-artwork-${instance}-active`);
        const unresolved = f.path.join(canonicalParent, `scient-artwork-${instance}-unresolved`);
        const foreign = f.path.join(canonicalParent, `scient-artwork-${instance}-foreign`);
        const outside = yield* f.fs.makeTempDirectoryScoped();
        const link = f.path.join(canonicalParent, `scient-artwork-${instance}-link`);
        for (const directory of [dead, unknown, malformed, active, unresolved, foreign])
          yield* f.fs.makeDirectory(directory);
        const marker = {
          kind: "scient-latex-artwork",
          version: 1,
          instance,
          pid: 2147483647,
          directory: dead,
          host: NodeOs.hostname(),
          retirement: "settled",
        };
        yield* f.fs.writeFileString(
          f.path.join(dead, ".scient-artwork-owner.json"),
          JSON.stringify(marker),
        );
        for (const [directory, retirement] of [
          [active, "active"],
          [unresolved, "unresolved"],
        ] as const)
          yield* f.fs.writeFileString(
            f.path.join(directory, ".scient-artwork-owner.json"),
            JSON.stringify({ ...marker, directory, retirement }),
          );
        yield* f.fs.writeFileString(
          f.path.join(foreign, ".scient-artwork-owner.json"),
          JSON.stringify({ ...marker, directory: foreign, host: `${marker.host}-another-host` }),
        );
        yield* f.fs.writeFileString(
          f.path.join(malformed, ".scient-artwork-owner.json"),
          '{"pid":2147483647}',
        );
        yield* f.fs.writeFileString(f.path.join(outside, "sentinel"), "Not owned by the cache");
        yield* f.fs.symlink(outside, link);
        const realKill = process.kill;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(process, "kill")
              .mockImplementation((pid: number, signal?: string | number) => {
                if (pid === marker.pid)
                  throw Object.assign(new Error("Absent fixture PID"), { code: "ESRCH" });
                return realKill(pid, signal);
              }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        yield* makeLatexArtworkWorkspaces(f.parent);
        expect(yield* f.fs.exists(dead)).toBe(false);
        expect(yield* f.fs.exists(live)).toBe(true);
        expect(yield* f.fs.exists(unknown)).toBe(true);
        expect(yield* f.fs.exists(malformed)).toBe(true);
        expect(yield* f.fs.exists(active)).toBe(true);
        expect(yield* f.fs.exists(unresolved)).toBe(true);
        expect(yield* f.fs.exists(foreign)).toBe(true);
        expect(yield* f.fs.exists(link)).toBe(true);
        expect(yield* f.fs.readFileString(f.path.join(outside, "sentinel"))).toBe(
          "Not owned by the cache",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("default search uncertainty forces passes without losing safely retired aux state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const options = {
        key: "distribution-defaults",
        searchPath: `${f.root}${pathDelimiter}`,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (directory: string, force: boolean) =>
          Effect.gen(function* () {
            const aux = f.path.join(directory, "picture.aux");
            if (f.runs.length === 0) yield* f.fs.writeFileString(aux, "Previous labels");
            else expect(yield* f.fs.readFileString(aux)).toBe("Previous labels");
            return yield* f.build(directory, force);
          }),
      };
      yield* f.use(options);
      yield* f.use(options);
      expect(f.runs.map((run) => run.force)).toEqual([true, true]);
      expect(f.runs[1]!.directory).toBe(f.runs[0]!.directory);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("invalidates literal negative lookups in already-existing nested directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.makeDirectory(f.path.join(f.root, "optional"));
      const options = {
        key: "negative-lookup",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
        run: (directory: string, force: boolean) =>
          Effect.gen(function* () {
            yield* f.fs.writeFileString(
              f.path.join(directory, "picture.tex"),
              "\\IfFileExists{optional/data.tex}{Present}{Absent}",
            );
            return yield* f.build(directory, force);
          }),
      };
      yield* f.use(options);
      yield* f.use(options);
      yield* f.fs.writeFileString(f.path.join(f.root, "optional/data.tex"), "New optional input");
      yield* f.use(options);
      expect(f.runs.map((run) => run.force)).toEqual([true, false, true]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "forces dynamic file lookups even when their previous recorder inputs remain unchanged",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const options = {
          key: "computed-file",
          searchPath: f.root,
          pathDelimiter,
          trackedInputs: [f.main],
          run: (directory: string, force: boolean) =>
            Effect.gen(function* () {
              yield* f.fs.writeFileString(
                f.path.join(directory, "picture.tex"),
                "\\input{\\computedFile}",
              );
              return yield* f.build(directory, force);
            }),
        };
        yield* f.use(options);
        yield* f.use(options);
        expect(f.runs.map((run) => run.force)).toEqual([true, true]);
        expect(f.runs[1]!.directory).toBe(f.runs[0]!.directory);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("quarantines failed retirement through queued successors and service teardown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const use = yield* makeLatexArtworkWorkspaces(f.parent).pipe(
        Effect.provideService(Scope.Scope, serviceScope),
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let directory = "";
      let successorRan = false;
      const options = {
        key: "uncertain-retirement",
        searchPath: f.root,
        pathDelimiter,
        trackedInputs: [f.main],
      };
      const first = yield* use({
        ...options,
        run: (target, force, onRetirementFailure) =>
          Effect.gen(function* () {
            directory = target;
            yield* f.build(target, force);
            yield* Effect.addFinalizer(() =>
              onRetirementFailure.pipe(Effect.andThen(Effect.die("Process retirement failed"))),
            );
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { _tag: "ready" as const, pdfBase64: "synthetic" };
          }),
      }).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      const second = yield* use({
        ...options,
        run: (target, force) => {
          successorRan = true;
          return f.build(target, force);
        },
      }).pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true);
      const result = yield* Fiber.join(second);
      expect(result._tag).toBe("unavailable");
      expect(successorRan).toBe(false);
      expect(yield* f.fs.exists(directory)).toBe(true);
      expect(
        JSON.parse(
          yield* f.fs.readFileString(f.path.join(directory, ".scient-artwork-owner.json")),
        ),
      ).toMatchObject({ retirement: "unresolved" });
      yield* Scope.close(serviceScope, Exit.void);
      expect(yield* f.fs.exists(directory)).toBe(true);
      yield* makeLatexArtworkWorkspaces(f.parent);
      expect(yield* f.fs.exists(directory)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses new work when quarantined directories hold the capacity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 8; index++)
        yield* f.use({
          key: `quarantined-${index}`,
          searchPath: f.root,
          pathDelimiter,
          trackedInputs: [f.main],
          run: (directory, force, onRetirementFailure) =>
            f
              .build(directory, force)
              .pipe(
                Effect.andThen(onRetirementFailure),
                Effect.as({ _tag: "unavailable" as const, message: "Unknown process retirement" }),
              ),
        });
      const result = yield* f.run("ninth-workspace");
      expect(result._tag).toBe("unavailable");
      expect(f.runs).toHaveLength(8);
      for (const run of f.runs) {
        expect(yield* f.fs.readFileString(f.path.join(run.directory, "picture.pdf"))).toBe(
          "Synthetic PDF",
        );
        expect(
          JSON.parse(
            yield* f.fs.readFileString(f.path.join(run.directory, ".scient-artwork-owner.json")),
          ),
        ).toMatchObject({ retirement: "unresolved" });
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
