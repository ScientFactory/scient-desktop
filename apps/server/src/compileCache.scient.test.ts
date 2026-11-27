// @effect-diagnostics nodeBuiltinImport:off -- Runs real Node processes against an isolated compile cache.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const serverRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

// Flushes a prepared backend's cache on the given platform and waits to be killed, as a Windows
// backend is when the app quits. Modules load after the cache is enabled. A self-kill would not
// do: Node persists the cache before signalling its own process.
const startup = `
  import * as NodeFS from "node:fs";
  import * as NodeModule from "node:module";
  NodeModule.enableCompileCache(process.env.CACHE_DIR);
  Reflect.set(globalThis, Symbol.for("t3code.preparedServerCache"), true);
  const Effect = await import("effect/Effect");
  const HostProcess = await import("@t3tools/shared/HostProcess");
  const { flushCompileCache } = await import("./src/compileCache.ts");
  await import(process.env.FRESH_MODULE);
  Effect.runSync(flushCompileCache.pipe(Effect.provideService(HostProcess.Platform, process.env.PLATFORM)));
  NodeFS.writeSync(1, "FLUSHED");
  setInterval(() => {}, 60_000);
`;
const nextLaunch = `
  import * as NodeModule from "node:module";
  NodeModule.enableCompileCache(process.env.CACHE_DIR);
  await import(process.env.FRESH_MODULE);
`;

it.live.each([
  { platform: "win32", cached: true },
  { platform: "darwin", cached: false },
  { platform: "linux", cached: false },
] as const)(
  "a prepared $platform backend that is killed leaves unprepared modules cached: $cached",
  ({ platform, cached }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compile-cache-test-" });
      const fresh = `${root}/fresh.mjs`;
      yield* fs.writeFileString(fresh, "export const fresh = 1;\n");
      const spawn = (script: string) =>
        spawner.spawn(
          ChildProcess.make(
            process.execPath,
            ["--experimental-strip-types", "--input-type=module", "--eval", script],
            {
              cwd: serverRoot,
              env: {
                CACHE_DIR: `${root}/cache`,
                FRESH_MODULE: NodeURL.pathToFileURL(fresh).href,
                PLATFORM: platform,
                NODE_DEBUG_NATIVE: "COMPILE_CACHE",
                NODE_COMPILE_CACHE: undefined,
                NODE_DISABLE_COMPILE_CACHE: undefined,
              },
            },
          ),
        );
      const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
        stream.pipe(Stream.decodeText(), Stream.mkString);

      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawn(startup);
          const stderr = yield* Effect.forkScoped(text(child.stderr));
          const stdout = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.takeUntil((chunk) => chunk.includes("FLUSHED")),
            Stream.mkString,
          );
          yield* child.kill({ killSignal: "SIGKILL" });
          return { stdout, stderr: yield* Fiber.join(stderr) };
        }),
      );
      expect(first.stdout, first.stderr).toBe("FLUSHED");
      const second = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawn(nextLaunch);
          return yield* Effect.all(
            { stderr: text(child.stderr), exitCode: child.exitCode },
            { concurrency: "unbounded" },
          );
        }),
      );
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.stderr.includes("fresh.mjs was accepted"), second.stderr).toBe(cached);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
