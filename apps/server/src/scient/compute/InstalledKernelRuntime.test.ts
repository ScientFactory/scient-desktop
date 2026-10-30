import { describe, expect, it } from "@effect/vitest";
import { ComputeLanguageId, ComputeRuntimeError } from "@scientfactory/compute";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  installedKernelLanguages,
  jupyterKernelDirectories,
  kernelLanguageId,
  makeInstalledKernelBinding,
} from "./InstalledKernelRuntime.ts";
import { RuntimeDiscoveryHostReference } from "./RuntimeDiscovery.ts";
import { fakeDiscoveryContext, fakeDiscoveryHost } from "./RuntimeDiscoveryTestHost.ts";

const rust = (argv: ReadonlyArray<string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ argv, display_name: "Rust", language: "Rust", ...extra });

const userKernels = "/home/ada/.local/share/jupyter/kernels";
const host = fakeDiscoveryHost({
  files: ["/home/ada/.cargo/bin/evcxr_jupyter", "/p/.venv/bin/python"],
  text: {
    [`${userKernels}/rust/kernel.json`]: rust(
      ["/home/ada/.cargo/bin/evcxr_jupyter", "--control_file", "{connection_file}"],
      { interrupt_mode: "message", env: { RUST_LOG: "warn" } },
    ),
    [`${userKernels}/python3/kernel.json`]: JSON.stringify({
      argv: ["python", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
      display_name: "Python 3",
      language: "python",
    }),
    [`${userKernels}/broken/kernel.json`]: "{ not json",
    "/p/.venv/pyvenv.cfg": "home = /usr/bin\n",
    "/p/.venv/share/jupyter/kernels/deno/kernel.json": JSON.stringify({
      argv: ["deno", "jupyter", "--kernel", "--conn", "{connection_file}"],
      display_name: "Deno",
      language: "typescript",
    }),
  },
});

const onHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(RuntimeDiscoveryHostReference, host),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Environment, { HOME: "/home/ada", PATH: "/usr/bin" }),
  );

const binding = (hostReady = true) =>
  makeInstalledKernelBinding(
    { languageId: ComputeLanguageId.make("rust"), displayName: "Rust", sourceExtensions: [".rs"] },
    {
      host: {
        bridgePath: "/bridge.py",
        transport: () => ({ open: () => Effect.die("unused") }),
        executable: () =>
          hostReady
            ? Effect.succeed("/managed/python")
            : Effect.fail(
                new ComputeRuntimeError({
                  operation: "prepare",
                  message: "Set up Scientific Python.",
                }),
              ),
      },
      configuredExecutable: () => Effect.succeed(null),
    },
  );

describe("installed Jupyter kernels", () => {
  it("names languages stably", () => {
    expect(["C++", "Rust", "C#", "TypeScript", "  "].map(kernelLanguageId)).toEqual([
      "cpp",
      "rust",
      "csharp",
      "typescript",
      "kernel",
    ]);
  });

  it("searches Jupyter's locations in order on each platform", () => {
    const empty = fakeDiscoveryHost({});
    expect(
      jupyterKernelDirectories(fakeDiscoveryContext("darwin", empty, { JUPYTER_PATH: "/a:/b" }), [
        "/env",
      ]),
    ).toEqual([
      "/a/kernels",
      "/b/kernels",
      "/home/ada/Library/Jupyter/kernels",
      "/env/share/jupyter/kernels",
      "/usr/local/share/jupyter/kernels",
      "/usr/share/jupyter/kernels",
    ]);
    expect(
      jupyterKernelDirectories(
        fakeDiscoveryContext("win32", empty, { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }),
        ["C:\\conda"],
      ),
    ).toEqual([
      "C:\\Users\\ada\\AppData\\Roaming\\jupyter\\kernels",
      "C:\\conda\\share\\jupyter\\kernels",
      "C:\\ProgramData\\jupyter\\kernels",
    ]);
  });

  it.effect("offers each new language once, skipping curated and unreadable kernels", () =>
    Effect.gen(function* () {
      expect(yield* installedKernelLanguages()).toEqual([
        { languageId: "rust", displayName: "Rust", sourceExtensions: [".rs"] },
      ]);
    }).pipe(onHost),
  );

  it.effect("launches an installed kernel exactly as its spec says, without variables", () =>
    Effect.gen(function* () {
      const rustBinding = yield* binding();
      const [profile] = yield* rustBinding.adapter.discover({
        projectRoot: "/p",
        configuredExecutable: null,
      });
      expect(profile).toMatchObject({
        executable: `${userKernels}/rust`,
        displayName: "Rust",
        source: "conventional",
      });
      expect(rustBinding.descriptor?.capabilities).not.toContain("variables");
      expect(
        yield* rustBinding.adapter.verify({ profile: profile!, cwd: "/p", environment: {} }),
      ).toMatchObject({ readiness: "ready", connection: "detected" });
      const plan = yield* rustBinding.adapter.prepareLaunch({
        profile: profile!,
        cwd: "/p",
        environment: {},
      });
      expect(plan.executable).toBe("/managed/python");
      expect(plan.kernel).toEqual({
        argv: ["/home/ada/.cargo/bin/evcxr_jupyter", "--control_file", "{connection_file}"],
        language: "Rust",
        interruptMode: "message",
        variablesExpression: null,
        env: { RUST_LOG: "warn" },
        resourceDir: `${userKernels}/rust`,
      });
    }).pipe(onHost),
  );

  it.effect("says what is missing instead of offering a kernel that cannot start", () =>
    Effect.gen(function* () {
      const rustBinding = yield* binding(false);
      const [profile] = yield* rustBinding.adapter.discover({
        projectRoot: null,
        configuredExecutable: null,
      });
      expect(
        yield* rustBinding.adapter.verify({ profile: profile!, cwd: "/p", environment: {} }),
      ).toMatchObject({
        readiness: "missing-requirement",
        message: "Set up Scientific Python.",
      });
      const gone = yield* rustBinding.adapter.discover({
        projectRoot: null,
        configuredExecutable: "/old/kernels/rust",
      });
      expect(gone[0]).toMatchObject({ source: "configured", executable: "/old/kernels/rust" });
      expect(
        (yield* rustBinding.adapter.verify({ profile: gone[0]!, cwd: "/p", environment: {} }))
          .message,
      ).toBe("This kernel is no longer installed.");
    }).pipe(onHost),
  );
});
