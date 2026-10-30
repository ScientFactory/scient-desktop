import { describe, expect, it } from "@effect/vitest";
import type { ExecutionProcessPort } from "@scientfactory/execution";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";
import { makeKernelRuntimeBinding, type KernelLanguage } from "./KernelComputeRuntime.ts";
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
