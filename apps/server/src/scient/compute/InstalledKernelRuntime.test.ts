import { describe, expect, it } from "@effect/vitest";
import {
  ComputeLanguageId,
  ComputeRuntimeError,
  computeLanguageIdFromName,
} from "@scientfactory/compute";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  jupyterKernelDirectories,
  kernelLanguages,
  kernelLaunch,
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
    expect(["C++", "Rust", "C#", "TypeScript", "  "].map(computeLanguageIdFromName)).toEqual([
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
      const languages = yield* kernelLanguages();
      expect(languages.map((language) => language.languageId)).toEqual([
        "octave",
        "rust",
        "spss",
        "stata",
        "wolfram-language",
      ]);
    }).pipe(onHost),
  );

  it.effect("keeps its setup languages listed when no kernel can be read", () =>
    Effect.gen(function* () {
      const languages = yield* kernelLanguages().pipe(
        Effect.provideService(RuntimeDiscoveryHostReference, fakeDiscoveryHost({})),
      );
      expect(languages.map((language) => language.displayName)).toEqual([
        "GNU Octave",
        "Rust",
        "SPSS",
        "Stata",
        "Wolfram Language",
      ]);
      expect(languages.find((language) => language.languageId === "spss")?.setup?.url).toBe(
        undefined,
      );
      expect(languages.find((language) => language.languageId === "rust")?.setup?.url).toContain(
        "evcxr",
      );
    }).pipe(onHost),
  );

  it("runs a bare python kernel with the Python it was installed for", () => {
    const spec = {
      name: "octave",
      resourceDir: "/env/share/jupyter/kernels/octave",
      displayName: "Octave",
      language: "octave",
      argv: ["python", "-m", "octave_kernel", "-f", "{connection_file}"],
      interruptMode: "signal" as const,
      env: { LANG: "C" },
    };
    const inEnvironment = fakeDiscoveryContext(
      "linux",
      fakeDiscoveryHost({ files: ["/env/bin/python3", "/usr/bin/python3"] }),
      { PATH: "/usr/bin" },
    );
    expect(kernelLaunch(inEnvironment, spec)).toEqual({
      argv: ["/env/bin/python3", "-m", "octave_kernel", "-f", "{connection_file}"],
      env: { LANG: "C", PATH: "/env/bin:/usr/bin" },
    });
    const onPath = fakeDiscoveryContext(
      "linux",
      fakeDiscoveryHost({ files: ["/usr/bin/python3"] }),
      { PATH: "/usr/bin" },
    );
    expect(kernelLaunch(onPath, { ...spec, resourceDir: "/u/.jupyter/kernels/octave" })).toEqual({
      argv: ["/usr/bin/python3", "-m", "octave_kernel", "-f", "{connection_file}"],
      env: { LANG: "C" },
    });
    const windows = fakeDiscoveryContext(
      "win32",
      fakeDiscoveryHost({ files: ["C:\\env\\python.exe"] }),
      { PATH: "C:\\Windows" },
    );
    expect(
      kernelLaunch(windows, {
        ...spec,
        resourceDir: "C:\\env\\share\\jupyter\\kernels\\octave",
      }),
    ).toEqual({
      argv: ["C:\\env\\python.exe", "-m", "octave_kernel", "-f", "{connection_file}"],
      env: { LANG: "C", PATH: "C:\\env;C:\\Windows" },
    });
    const absolute = { ...spec, argv: ["/opt/evcxr", "{connection_file}"] };
    expect(kernelLaunch(inEnvironment, absolute)).toBe(absolute);
  });

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
