import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ExecutionProcessPort } from "@scientfactory/execution";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";

import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";
import {
  makeKernelRuntimeBinding,
  replaceDirectory,
  type KernelLanguage,
} from "./KernelComputeRuntime.ts";
import { R_KERNEL_LANGUAGE } from "./RComputeRuntime.ts";
import { RuntimeDiscoveryHostReference } from "./RuntimeDiscovery.ts";
import { fakeDiscoveryHost } from "./RuntimeDiscoveryTestHost.ts";

// Inventory never launches an installation.
const processes: ExecutionProcessPort = { start: () => Effect.die("inventory launched a process") };

const inventory = (
  language: KernelLanguage,
  platform: NodeJS.Platform,
  environment: Record<string, string>,
  host: ReturnType<typeof fakeDiscoveryHost>,
  configuredExecutable: string | null = null,
) =>
  Effect.gen(function* () {
    const binding = yield* makeKernelRuntimeBinding(language, {
      host: {
        bridgePath: "/bridge.py",
        mayHost: () => Effect.succeed(true),
        transport: () => ({ open: () => Effect.die("unused") }),
        executable: () => Effect.die("unused"),
      },
      computeDir: "/compute",
      processes,
      configuredExecutable: () => Effect.succeed(null),
    });
    const rows = yield* binding.adapter.listInstallations!({
      projectRoot: null,
      configuredExecutable,
    });
    return rows.map((row) => [row.executable, row.source, row.problem]);
  }).pipe(
    Effect.scoped,
    Effect.provideService(RuntimeDiscoveryHostReference, host),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provide(FileSystem.layerNoop({})),
  );

describe("kernel language inventory", () => {
  it.effect("finds per-user Windows R and every PATH match without launching", () =>
    Effect.gen(function* () {
      const local = "C:\\Users\\ada\\AppData\\Local";
      expect(
        yield* inventory(
          R_KERNEL_LANGUAGE,
          "win32",
          {
            Path: "C:\\Tools\\R\\bin;D:\\R\\bin",
            LOCALAPPDATA: local,
            ProgramFiles: "C:\\Program Files",
          },
          fakeDiscoveryHost({
            separator: "\\",
            files: [
              "C:\\Tools\\R\\bin\\R.exe",
              "D:\\R\\bin\\R.exe",
              `${local}\\Programs\\R\\R-4.4.1\\bin\\R.exe`,
              "C:\\Program Files\\R\\R-4.3.2\\bin\\R.exe",
            ],
          }),
        ),
      ).toEqual([
        ["C:\\Tools\\R\\bin\\R.exe", "path", null],
        ["D:\\R\\bin\\R.exe", "path", null],
        ["C:\\Program Files\\R\\R-4.3.2\\bin\\R.exe", "conventional", null],
        [`${local}\\Programs\\R\\R-4.4.1\\bin\\R.exe`, "conventional", null],
      ]);
    }),
  );

  it.effect("lists rig's side-by-side R versions on macOS and Linux", () =>
    Effect.gen(function* () {
      expect(
        yield* inventory(
          R_KERNEL_LANGUAGE,
          "linux",
          { PATH: "/usr/bin" },
          fakeDiscoveryHost({ files: ["/opt/R/4.4.1/bin/R", "/opt/R/4.3.3/bin/R"] }),
        ),
      ).toEqual([
        ["/opt/R/4.4.1/bin/R", "conventional", null],
        ["/opt/R/4.3.3/bin/R", "conventional", null],
      ]);
    }),
  );

  it.effect("keeps a missing chosen Julia visible ahead of the installations found", () =>
    Effect.gen(function* () {
      expect(
        yield* inventory(
          JULIA_KERNEL_LANGUAGE,
          "darwin",
          { HOME: "/Users/ada", PATH: "/usr/bin" },
          fakeDiscoveryHost({
            files: ["/Users/ada/Applications/Julia-1.11.app/Contents/Resources/julia/bin/julia"],
          }),
          "/old/julia",
        ),
      ).toEqual([
        ["/old/julia", "configured", expect.stringContaining("not found")],
        [
          "/Users/ada/Applications/Julia-1.11.app/Contents/Resources/julia/bin/julia",
          "conventional",
          null,
        ],
      ]);
    }),
  );
});

describe("replacing a private kernel", () => {
  const installed = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const parent = yield* fileSystem.makeTempDirectoryScoped();
    const directory = `${parent}/kernel`;
    yield* fileSystem.makeDirectory(directory);
    yield* fileSystem.writeFileString(`${directory}/working`, "yes");
    return { fileSystem, parent, directory };
  });

  it.live("puts the working kernel back when a repair is cancelled", () =>
    Effect.gen(function* () {
      const { fileSystem, parent, directory } = yield* installed;
      const filling = yield* Deferred.make<void>();
      const repair = yield* replaceDirectory(
        fileSystem,
        directory,
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(directory);
          yield* fileSystem.writeFileString(`${directory}/partial`, "no");
          yield* Deferred.succeed(filling, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(filling);
      yield* Fiber.interrupt(repair);
      expect(yield* fileSystem.readDirectory(directory)).toEqual(["working"]);
      expect(yield* fileSystem.readDirectory(parent)).toEqual(["kernel"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("puts the working kernel back when a repair fails, and keeps a finished one", () =>
    Effect.gen(function* () {
      const { fileSystem, parent, directory } = yield* installed;
      const failed = yield* replaceDirectory(fileSystem, directory, Effect.fail("failed")).pipe(
        Effect.flip,
      );
      expect(failed).toBe("failed");
      expect(yield* fileSystem.readDirectory(directory)).toEqual(["working"]);
      yield* replaceDirectory(
        fileSystem,
        directory,
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(directory);
          yield* fileSystem.writeFileString(`${directory}/new`, "yes");
        }),
      );
      expect(yield* fileSystem.readDirectory(directory)).toEqual(["new"]);
      expect(yield* fileSystem.readDirectory(parent)).toEqual(["kernel"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
