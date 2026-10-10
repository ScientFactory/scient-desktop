import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { latexArtworkWorkspaceKey, makeLatexArtworkWorkspaces } from "./latexArtworkWorkspaces.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const parent = yield* fs.makeTempDirectoryScoped();
  const main = path.join(root, "main.tex");
  const data = path.join(root, "data.tex");
  yield* fs.writeFileString(main, "Main");
  yield* fs.writeFileString(data, "aaaa");
  const use = yield* makeLatexArtworkWorkspaces;
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
    use({ key, parent, workspaceRoot: root, trackedInputs: [main], run: build });
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

it.effect("forces a rebuild when project search-path entries are added", () =>
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
        parent: f.parent,
        workspaceRoot: f.root,
        trackedInputs: [f.main],
        run: () => Effect.succeed({ _tag: "unavailable" as const, message: "Failure" }),
      });
      expect(yield* f.fs.exists(old)).toBe(false);
      const entered = yield* Deferred.make<void>();
      let interruptedDirectory = "";
      const fiber = yield* f
        .use({
          key: "picture",
          parent: f.parent,
          workspaceRoot: f.root,
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
        parent: f.parent,
        workspaceRoot: f.root,
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
          const use = yield* makeLatexArtworkWorkspaces;
          yield* use({
            key: "picture",
            parent: f.parent,
            workspaceRoot: f.root,
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

it.effect("keeps no build state without a complete recorder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let directory = "";
      yield* f.use({
        key: "picture",
        parent: f.parent,
        workspaceRoot: f.root,
        trackedInputs: [f.main],
        run: (target, force) =>
          Effect.gen(function* () {
            directory = target;
            const result = yield* f.build(target, force);
            yield* f.fs.writeFileString(f.path.join(target, "picture.fls"), "INPUT unknown\n");
            return result;
          }),
      });
      expect(yield* f.fs.exists(directory)).toBe(false);
      yield* f.run();
      expect(f.runs.at(-1)!.force).toBe(true);
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
        parent: f.parent,
        workspaceRoot: f.root,
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
        parent: f.parent,
        workspaceRoot: f.root,
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
