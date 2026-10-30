// @effect-diagnostics preferSchemaOverJson:off -- test data uses JSON for probe simulation.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  ComputeRuntimeError,
  type ComputeLaunchRequest,
  type ComputeRuntimeProfile,
} from "@scientfactory/compute";

import {
  buildLaunchPlan,
  buildProfile,
  checkReadiness,
  computeFingerprint,
  makePythonRuntimeAdapter,
  pythonCandidates,
  parseProbeOutput,
  OBSERVED_PYTHON_PACKAGES,
  PYTHON_LANGUAGE_ID,
  JUPYTER_BRIDGE_TRANSPORT_KIND,
  PROBE_SCRIPT,
} from "./PythonRuntimeAdapter.ts";
import { RuntimeDiscoveryHostReference } from "./RuntimeDiscovery.ts";
import { fakeDiscoveryHost } from "./RuntimeDiscoveryTestHost.ts";

const validProbeOutput = JSON.stringify({
  executable: "/usr/bin/python3",
  executableRealpath: "/Library/Python/3.12/bin/python3.12",
  executableMtimeNs: "1724112000000000000",
  implementation: "CPython",
  version: "3.12.0",
  architecture: "arm64",
  prefix: "/usr",
  base_prefix: "/usr",
  platform: "darwin",
  packages: {
    jupyter_client: "8.6.1",
    ipykernel: "6.29.0",
    matplotlib: "3.9.0",
    nbformat: "5.10.4",
    numpy: "1.26.0",
    pandas: "2.2.0",
    plotly: "6.3.0",
    scipy: null,
  },
});

const profile: ComputeRuntimeProfile = {
  languageId: PYTHON_LANGUAGE_ID,
  source: "path",
  executable: "/usr/bin/python3",
  languageVersion: "3.12.0",
  architecture: "arm64",
  displayName: "Python 3.12.0 (path)",
};

const onHost =
  (host: ReturnType<typeof fakeDiscoveryHost>, environment: Record<string, string> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(RuntimeDiscoveryHostReference, host),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, { HOME: "/home/ada", ...environment }),
    );

describe("Python filesystem inventory", () => {
  it.effect("keeps a selected PATH installation's provenance and virtualenvs distinct", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(() => Effect.never, "/bridge.py");
      for (const configuredExecutable of ["python3", "/system/python3"]) {
        const rows = yield* adapter.listInstallations!({
          projectRoot: null,
          configuredExecutable,
          refresh: true,
        });
        expect(rows).toEqual([
          {
            executable: "/system/python3",
            source: "path",
            configured: true,
            version: null,
            problem: null,
          },
        ]);
      }
      const rows = yield* adapter.listInstallations!({
        projectRoot: null,
        configuredExecutable: "/venv/bin/python",
        refresh: true,
      });
      expect(rows.map((row) => row.executable)).toEqual(["/venv/bin/python", "/system/python3"]);
    }).pipe(
      onHost(fakeDiscoveryHost({ files: ["/system/python3", "/venv/bin/python"] }), {
        PATH: "/system",
      }),
    ),
  );

  it.effect.each(
    [true, false].map((selected) => ({
      caseTitle: `preserves managed ownership when also configured (selected=${selected})`,
      selected,
    })),
  )("$caseTitle", ({ selected }) =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(() => Effect.never, "/bridge.py", {
        managedRuntime: () =>
          Effect.succeed({
            executable: "/managed/python",
            selected,
            available: true,
            version: "3.12.13",
          }),
      });
      const rows = yield* adapter.listInstallations!({
        projectRoot: null,
        configuredExecutable: "/managed/python",
        refresh: true,
      });
      expect(rows).toEqual([
        {
          executable: "/managed/python",
          source: "managed",
          configured: true,
          version: "3.12.13",
          problem: null,
        },
      ]);
    }).pipe(onHost(fakeDiscoveryHost({ files: ["/managed/python"] }))),
  );

  it.effect("preserves managed selection and venv identity without spawning a probe", () =>
    Effect.gen(function* () {
      let available = true;
      const adapter = makePythonRuntimeAdapter(() => Effect.never, "/bridge.py", {
        managedRuntime: () =>
          Effect.succeed({
            executable: "/managed/venv/bin/python",
            selected: true,
            available,
            version: "3.12.13",
          }),
      });
      const request = {
        projectRoot: null,
        configuredExecutable: "/project/venv/bin/python",
        refresh: true,
      };
      const first = yield* adapter.listInstallations!(request);
      expect(first).toEqual([
        {
          executable: "/managed/venv/bin/python",
          source: "managed",
          version: "3.12.13",
          problem: null,
        },
        {
          executable: "/project/venv/bin/python",
          source: "configured",
          configured: true,
          version: null,
          problem: null,
        },
      ]);
      available = false;
      expect((yield* adapter.listInstallations!(request))[0]?.problem).toContain("repair");
    }).pipe(
      onHost(
        fakeDiscoveryHost({ files: ["/managed/venv/bin/python", "/project/venv/bin/python"] }),
      ),
    ),
  );

  it.effect("shows a missing explicit executable without silently selecting PATH Python", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(() => Effect.never, "/bridge.py");
      expect(
        yield* adapter.listInstallations!({
          projectRoot: null,
          configuredExecutable: "/missing/python",
          refresh: true,
        }),
      ).toEqual([
        {
          executable: "/missing/python",
          source: "configured",
          configured: true,
          version: null,
          problem: expect.stringContaining("not found"),
        },
        { executable: "/usr/local/bin/python3", source: "path", version: null, problem: null },
      ]);
    }).pipe(
      onHost(fakeDiscoveryHost({ files: ["/usr/local/bin/python3"] }), { PATH: "/usr/local/bin" }),
    ),
  );

  it.effect("lists a conda environment outside PATH with where it came from", () =>
    Effect.gen(function* () {
      const adapter = makePythonRuntimeAdapter(() => Effect.never, "/bridge.py");
      expect(
        yield* adapter.listInstallations!({ projectRoot: null, configuredExecutable: null }),
      ).toEqual([
        {
          executable: "/home/ada/miniforge3/envs/lab/bin/python",
          source: "conventional",
          origin: "conda: lab",
          version: null,
          problem: null,
        },
      ]);
    }).pipe(
      onHost(
        fakeDiscoveryHost({
          files: [
            "/home/ada/miniforge3/envs/lab/bin/python",
            "/home/ada/miniforge3/envs/lab/conda-meta/history",
          ],
        }),
      ),
    ),
  );
});

describe("python probe parsing", () => {
  it("parses valid probe output", () => {
    const result = parseProbeOutput(validProbeOutput);
    expect(result.executable).toBe("/usr/bin/python3");
    expect(result.implementation).toBe("CPython");
    expect(result.version).toBe("3.12.0");
    expect(result.packages["jupyter_client"]).toBe("8.6.1");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseProbeOutput("not json")).toThrow();
  });

  it("rejects output missing required fields", () => {
    expect(() => parseProbeOutput(JSON.stringify({ executable: "/python" }))).toThrow();
  });

  it("handles packages with null (absent) values", () => {
    const result = parseProbeOutput(
      JSON.stringify({
        executable: "/python",
        executableRealpath: "/python",
        executableMtimeNs: "1724112000000000000",
        implementation: "CPython",
        version: "3.12.0",
        architecture: null,
        prefix: "/usr",
        base_prefix: "/usr",
        platform: "linux",
        packages: { jupyter_client: null, ipykernel: null },
      }),
    );
    expect(result.packages["jupyter_client"]).toBeNull();
  });
});

describe("python readiness check", () => {
  it("returns ready when all requirements are met", () => {
    const { readiness, missing } = checkReadiness(parseProbeOutput(validProbeOutput));
    expect(readiness).toBe("ready");
    expect(missing).toEqual([]);
  });

  it("returns unsupported-version for non-CPython", () => {
    const { readiness } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      implementation: "PyPy",
    });
    expect(readiness).toBe("unsupported-version");
  });

  it("returns missing-requirement for old Python", () => {
    const { readiness, missing } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      version: "3.9.0",
    });
    expect(readiness).toBe("missing-requirement");
    expect(missing.some((m) => m.includes("Python"))).toBe(true);
  });

  it("returns missing-requirement for absent jupyter_client", () => {
    const { readiness, missing } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      packages: { ...parseProbeOutput(validProbeOutput).packages, jupyter_client: null },
    });
    expect(readiness).toBe("missing-requirement");
    expect(missing).toContain("jupyter_client");
  });

  it("returns missing-requirement for old ipykernel", () => {
    const { readiness, missing } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      packages: { ...parseProbeOutput(validProbeOutput).packages, ipykernel: "6.28.0" },
    });
    expect(readiness).toBe("missing-requirement");
    expect(missing.some((m) => m.includes("ipykernel"))).toBe(true);
  });

  it("rejects malformed and minimum-version prerelease values", () => {
    for (const version of ["8.6rc1", "8.6.dev1", "not-a-version"]) {
      const { readiness } = checkReadiness({
        ...parseProbeOutput(validProbeOutput),
        packages: { ...parseProbeOutput(validProbeOutput).packages, jupyter_client: version },
      });
      expect(readiness).toBe("missing-requirement");
    }
  });

  it("accepts a post release at the minimum version", () => {
    const { readiness } = checkReadiness({
      ...parseProbeOutput(validProbeOutput),
      packages: { ...parseProbeOutput(validProbeOutput).packages, jupyter_client: "8.6.post1" },
    });
    expect(readiness).toBe("ready");
  });
});

describe("python profile building", () => {
  it("builds a profile from a probe result", () => {
    const p = buildProfile(parseProbeOutput(validProbeOutput), "path");
    expect(p.languageId).toBe(PYTHON_LANGUAGE_ID);
    expect(p.source).toBe("path");
    expect(p.executable).toBe("/usr/bin/python3");
    expect(p.languageVersion).toBe("3.12.0");
  });
});

describe("python launch plan", () => {
  it("builds a launch plan with -I -u and the bridge path", () => {
    const request: ComputeLaunchRequest = {
      profile,
      cwd: "/project",
      environment: { HOME: "/home/user" },
    };
    const plan = buildLaunchPlan(request, "/app/bridge.py");
    expect(plan.executable).toBe("/usr/bin/python3");
    expect(plan.args).toEqual(["-I", "-u", "/app/bridge.py"]);
    expect(plan.cwd).toBe("/project");
    expect(plan.environment.HOME).toBe("/home/user");
  });

  it("applies the environment policy so no caller can skip it", () => {
    const request: ComputeLaunchRequest = {
      profile,
      cwd: "/project",
      environment: {
        HOME: "/home/user",
        PYTHONPATH: "/attacker/lib",
        CLAUDE_CODE_OAUTH_TOKEN: "secret",
        SCIENT_INTERNAL: "secret",
      },
    };
    const plan = buildLaunchPlan(request, "/app/bridge.py");
    expect(plan.environment).toEqual({
      HOME: "/home/user",
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
    });
  });

  it("rejects a working directory that is not absolute and canonical", () => {
    const relative: ComputeLaunchRequest = { profile, cwd: "project", environment: {} };
    expect(() => buildLaunchPlan(relative, "/app/bridge.py")).toThrow("absolute");
    const traversal: ComputeLaunchRequest = { profile, cwd: "/a/../b", environment: {} };
    expect(() => buildLaunchPlan(traversal, "/app/bridge.py")).toThrow("canonical");
  });
});

describe("python fingerprint", () => {
  it("computes a bounded sha256 fingerprint with runtime provenance contributors", () => {
    const fp = computeFingerprint(profile, parseProbeOutput(validProbeOutput));
    expect(fp.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp.contributors).toContain("executable");
    expect(fp.contributors).toContain("executableMtimeNs");
    expect(fp.contributors).toContain("languageVersion");
    expect(fp.contributors).toContain("architecture");
    expect(fp.contributors).toContain("implementation");
    expect(fp.contributors).toContain("prefix");
    expect(fp.contributors).toContain("jupyter_client");
    expect(fp.contributors).toContain("ipykernel");
    expect(fp.contributors).toContain("nbformat");
    expect(fp.contributors).toContain("plotly");
    expect(fp.contributors).toContain("scipy");
  });

  it("changes when the selected executable contents change at the same path", () => {
    const probe = parseProbeOutput(validProbeOutput);
    const first = computeFingerprint(profile, probe);
    const second = computeFingerprint(profile, {
      ...probe,
      executableMtimeNs: "1724112000000000001",
    });
    expect(second.hash).not.toBe(first.hash);
  });
});

describe("python candidate order", () => {
  const found = [
    {
      executable: "/p/.venv/bin/python",
      source: "project" as const,
      origin: ".venv",
      problem: null,
    },
    { executable: "/usr/bin/python3", source: "path" as const, origin: null, problem: null },
  ];

  it("places a selected managed Python, then the configured one, before discovered runtimes", () => {
    expect(
      pythonCandidates(found, "/custom/python", {
        executable: "/managed/python",
        selected: true,
      }).map((candidate) => [candidate.executable, candidate.source]),
    ).toEqual([
      ["/managed/python", "managed"],
      ["/custom/python", "configured"],
      ["/p/.venv/bin/python", "project"],
      ["/usr/bin/python3", "path"],
    ]);
  });

  it("keeps an unselected managed Python last and a configured duplicate under its choice", () => {
    expect(
      pythonCandidates(found, "/usr/bin/python3", {
        executable: "/managed/python",
        selected: false,
      }).map((candidate) => [candidate.executable, candidate.source]),
    ).toEqual([
      ["/usr/bin/python3", "configured"],
      ["/p/.venv/bin/python", "project"],
      ["/managed/python", "managed"],
    ]);
  });
});

// Discovery here sees only the configured or managed runtime each test names.
it.layer(Layer.succeed(RuntimeDiscoveryHostReference, fakeDiscoveryHost({})))(
  "python runtime adapter",
  (it) => {
    const fakeSpawnProbe = (stdout: string) => (_executable: string) => Effect.succeed(stdout);

    const fakeFailingProbe = (_executable: string) =>
      Effect.fail(new ComputeRuntimeError({ operation: "discover", message: "Probe failed." }));

    it.effect("discovers profiles from viable candidates", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(
          fakeSpawnProbe(validProbeOutput),
          "/app/bridge.py",
        );
        const profiles = yield* adapter.discover({
          projectRoot: "/nonexistent",
          configuredExecutable: null,
        });
        expect(profiles.length).toBeGreaterThan(0);
        expect(profiles[0]!.languageId).toBe(PYTHON_LANGUAGE_ID);
      }).pipe(
        onHost(fakeDiscoveryHost({ files: ["/usr/local/bin/python3"] }), {
          PATH: "/usr/local/bin",
        }),
      ),
    );

    it.effect("keeps a broken project environment first instead of falling through to PATH", () =>
      Effect.gen(function* () {
        const probed: string[] = [];
        const adapter = makePythonRuntimeAdapter((executable) => {
          probed.push(executable);
          return Effect.succeed(
            JSON.stringify({ ...parseProbeOutput(validProbeOutput), executable }),
          );
        }, "/app/bridge.py");
        const profiles = yield* adapter.discover({ projectRoot: "/p", configuredExecutable: null });
        expect(profiles.map((candidate) => [candidate.source, candidate.languageVersion])).toEqual([
          ["project", "unknown"],
          ["path", "3.12.0"],
        ]);
        expect(probed).toEqual(["/usr/local/bin/python3"]);
        const verification = yield* adapter.verify({
          profile: profiles[0]!,
          cwd: "/p",
          environment: {},
        });
        expect(verification.message).toBe(
          "The project environment cannot run. Its Python is missing. Recreate the environment.",
        );
      }).pipe(
        onHost(
          fakeDiscoveryHost({
            files: ["/usr/local/bin/python3"],
            links: { "/p/.venv/bin/python": "/gone/python3" },
          }),
          { PATH: "/usr/local/bin" },
        ),
      ),
    );

    it.effect("lists a runtime whose probe fails, with the failure, instead of hiding it", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(fakeFailingProbe, "/app/bridge.py");
        const profiles = yield* adapter.discover({ projectRoot: null, configuredExecutable: null });
        expect(profiles).toMatchObject([{ source: "path", languageVersion: "unknown" }]);
        expect(
          (yield* adapter.verify({ profile: profiles[0]!, cwd: "/p", environment: {} })).message,
        ).toBe("This Python cannot run: Probe failed.");
      }).pipe(
        onHost(fakeDiscoveryHost({ files: ["/usr/local/bin/python3"] }), {
          PATH: "/usr/local/bin",
        }),
      ),
    );

    it.effect("reuses the selected probe across discovery, verification, and fingerprinting", () =>
      Effect.gen(function* () {
        let calls = 0;
        const adapter = makePythonRuntimeAdapter(
          () =>
            Effect.sync(() => {
              calls += 1;
              return validProbeOutput;
            }),
          "/app/bridge.py",
        );
        const profiles = yield* adapter.discover({
          projectRoot: "/nonexistent",
          configuredExecutable: "/usr/bin/python3",
        });
        const selected = profiles[0]!;
        const afterDiscovery = calls;
        yield* adapter.verify({ profile: selected, cwd: "/project", environment: {} });
        yield* adapter.fingerprintEnvironment(selected);
        expect(calls).toBe(afterDiscovery);
      }),
    );

    it.effect("bypasses the short-lived probe cache on an explicit refresh", () =>
      Effect.gen(function* () {
        let calls = 0;
        const adapter = makePythonRuntimeAdapter(
          () =>
            Effect.sync(() => {
              calls += 1;
              return validProbeOutput;
            }),
          "/app/bridge.py",
        );
        yield* adapter.discover({
          projectRoot: null,
          configuredExecutable: "/usr/bin/python3",
        });
        const afterFirstInspection = calls;
        yield* adapter.discover({
          projectRoot: null,
          configuredExecutable: "/usr/bin/python3",
          refresh: true,
        });
        expect(calls).toBeGreaterThan(afterFirstInspection);
      }),
    );

    it("reads package versions without importing scientific packages", () => {
      expect(PROBE_SCRIPT).toContain("metadata.version(pkg)");
      expect(PROBE_SCRIPT).not.toContain("__import__(pkg)");
    });

    it.effect("returns a configured-but-invalid profile without replacing it", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(fakeFailingProbe, "/app/bridge.py");
        const profiles = yield* adapter.discover({
          projectRoot: "/nonexistent",
          configuredExecutable: "/bad/python",
        });
        expect(profiles).toHaveLength(1);
        expect(profiles[0]!.source).toBe("configured");
        expect(profiles[0]!.languageVersion).toBe("unknown");
        expect(
          (yield* adapter.verify({ profile: profiles[0]!, cwd: "/project", environment: {} }))
            .message,
        ).toContain("Probe failed.");
      }),
    );

    it.effect("does not let a stale configured path replace selected managed Python", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(
          (executable) =>
            executable === "/managed/python"
              ? Effect.succeed(
                  JSON.stringify({ ...parseProbeOutput(validProbeOutput), executable }),
                )
              : fakeFailingProbe(executable),
          "/app/bridge.py",
          {
            managedRuntime: () => Effect.succeed({ executable: "/managed/python", selected: true }),
          },
        );
        const profiles = yield* adapter.discover({
          projectRoot: null,
          configuredExecutable: "/removed/python",
        });
        expect(profiles[0]).toMatchObject({ source: "managed", executable: "/managed/python" });
        expect(profiles[1]).toMatchObject({
          source: "configured",
          executable: "/removed/python",
          languageVersion: "unknown",
        });
      }),
    );

    it.effect("reports a missing selected managed runtime without choosing another Python", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(fakeFailingProbe, "/app/bridge.py", {
          managedRuntime: () => Effect.succeed({ executable: "/managed/python", selected: true }),
        });
        const profiles = yield* adapter.discover({
          projectRoot: null,
          configuredExecutable: "/custom/python",
        });
        expect(profiles[0]).toMatchObject({
          source: "managed",
          executable: "/managed/python",
          languageVersion: "unknown",
        });
      }),
    );

    it.effect(
      "keeps an unavailable managed choice first while allowing an explicit existing choice",
      () =>
        Effect.gen(function* () {
          const probed: string[] = [];
          const adapter = makePythonRuntimeAdapter(
            (executable) => {
              probed.push(executable);
              return executable === "/custom/python"
                ? Effect.succeed(
                    JSON.stringify({ ...parseProbeOutput(validProbeOutput), executable }),
                  )
                : fakeFailingProbe(executable);
            },
            "/app/bridge.py",
            {
              managedRuntime: () =>
                Effect.succeed({ executable: "/managed/python", selected: true, available: false }),
            },
          );
          const profiles = yield* adapter.discover({
            projectRoot: null,
            configuredExecutable: "/custom/python",
            refresh: true,
          });
          expect(profiles[0]).toMatchObject({ source: "managed", languageVersion: "unknown" });
          expect(profiles[1]).toMatchObject({ source: "configured", executable: "/custom/python" });
          expect(
            (yield* adapter.verify({ profile: profiles[0]!, cwd: "/project", environment: {} }))
              .readiness,
          ).toBe("unusable");
          expect(probed).not.toContain("/managed/python");
        }),
    );

    it.effect("does not silently choose system Python when managed-state inspection fails", () =>
      Effect.gen(function* () {
        let probed = false;
        const failure = new ComputeRuntimeError({
          operation: "discover",
          message: "Managed root is unsafe.",
        });
        const adapter = makePythonRuntimeAdapter(
          () => {
            probed = true;
            return Effect.succeed(validProbeOutput);
          },
          "/app/bridge.py",
          { managedRuntime: () => Effect.fail(failure) },
        );
        const result = yield* Effect.result(
          adapter.discover({ projectRoot: null, configuredExecutable: null }),
        );
        expect(result).toMatchObject({ _tag: "Failure", failure });
        expect(probed).toBe(false);
      }),
    );

    it.effect("verifies a ready environment", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(
          fakeSpawnProbe(validProbeOutput),
          "/app/bridge.py",
        );
        const verification = yield* adapter.verify({
          profile,
          cwd: "/project",
          environment: {},
        });
        expect(verification.readiness).toBe("ready");
        expect(verification.connection).toBe("detected");
        expect(verification.message).toBeNull();
        const reported = JSON.parse(validProbeOutput).packages as Record<string, string | null>;
        expect(verification.packages).toEqual(
          OBSERVED_PYTHON_PACKAGES.map((name) => ({ name, version: reported[name] ?? null })),
        );
      }),
    );

    it.effect("verifies a missing-requirement environment", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(
          fakeSpawnProbe(
            JSON.stringify({
              ...JSON.parse(validProbeOutput),
              packages: {
                jupyter_client: null,
                ipykernel: null,
                matplotlib: null,
                numpy: null,
                pandas: null,
                plotly: null,
              },
            }),
          ),
          "/app/bridge.py",
        );
        const verification = yield* adapter.verify({
          profile,
          cwd: "/project",
          environment: {},
        });
        expect(verification.readiness).toBe("missing-requirement");
        expect(verification.connection).toBeUndefined();
        expect(verification.missingRequirements).toContain("jupyter_client");
        expect(verification.message).toBe(
          "Create or select a Python environment that satisfies: jupyter_client, ipykernel. " +
            "Project .venv environments are detected when that project is open. " +
            "Scient's isolated compute bridge does not load packages installed with pip --user.",
        );
      }),
    );

    // regression: c4de0a4c6f feat: implement Phase 2 compute session bridge protocol and Python runtime
    it.effect("builds a launch plan through prepareLaunch", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(
          fakeSpawnProbe(validProbeOutput),
          "/app/bridge.py",
        );
        const plan = yield* adapter.prepareLaunch({
          profile,
          cwd: "/project",
          environment: { PYTHONUTF8: "1" },
        });
        expect(plan.args).toEqual(["-I", "-u", "/app/bridge.py"]);
      }),
    );

    // regression: c4de0a4c6f feat: implement Phase 2 compute session bridge protocol and Python runtime
    it("normalizes diagnostics through the adapter", () => {
      const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
      const diagnostics = adapter.normalizeDiagnostic(
        {
          name: "ValueError",
          value: "bad value",
          traceback: ["line 1", "line 2"],
        },
        { projectRoot: "/project", submittedSource: null },
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.errorName).toBe("ValueError");
    });

    // regression: c4de0a4c6f feat: implement Phase 2 compute session bridge protocol and Python runtime
    it.effect("computes a fingerprint through the adapter", () =>
      Effect.gen(function* () {
        const adapter = makePythonRuntimeAdapter(
          fakeSpawnProbe(validProbeOutput),
          "/app/bridge.py",
        );
        const fp = yield* adapter.fingerprintEnvironment(profile);
        expect(fp.hash).toMatch(/^sha256:/);
      }),
    );

    it.effect("fails rather than dies when a probe cannot be parsed", () =>
      Effect.gen(function* () {
        // A wrapper script, a stray banner, a Python that prints nothing useful.
        // The coordinator starts a session without a fingerprint, but only if it
        // is told in the failure channel -- a defect would take the start down.
        const adapter = makePythonRuntimeAdapter(
          fakeSpawnProbe("not json at all"),
          "/app/bridge.py",
        );
        const error = yield* Effect.flip(adapter.fingerprintEnvironment(profile));
        expect(error.operation).toBe("fingerprint");
        expect(error.message).toContain("malformed");
      }),
    );

    it.effect("answers a configured interpreter that cannot describe itself with itself", () =>
      Effect.gen(function* () {
        // The probe runs and says nothing usable, which is as unusable as a probe
        // that would not run. Falling through to whatever else is installed would
        // silently run the user's code on an interpreter they did not choose.
        const adapter = makePythonRuntimeAdapter(
          fakeSpawnProbe("not json at all"),
          "/app/bridge.py",
        );
        const profiles = yield* adapter.discover({
          projectRoot: "/nonexistent",
          configuredExecutable: "/bad/python",
        });
        expect(profiles).toHaveLength(1);
        expect(profiles[0]!.source).toBe("configured");
        expect(profiles[0]!.executable).toBe("/bad/python");
        expect(profiles[0]!.languageVersion).toBe("unknown");
      }),
    );

    // regression: c4de0a4c6f feat: implement Phase 2 compute session bridge protocol and Python runtime
    it("reports the correct language and transport kind", () => {
      const adapter = makePythonRuntimeAdapter(fakeSpawnProbe(validProbeOutput), "/app/bridge.py");
      expect(adapter.languageId).toBe(PYTHON_LANGUAGE_ID);
      expect(adapter.transportKind).toBe(JUPYTER_BRIDGE_TRANSPORT_KIND);
    });
  },
);
