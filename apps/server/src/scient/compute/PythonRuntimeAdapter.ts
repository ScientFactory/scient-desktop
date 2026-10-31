// @effect-diagnostics nodeBuiltinImport:off -- fingerprints hash and configured paths are host paths.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  ComputeEnvironmentFingerprint,
  ComputeLanguageId,
  ComputeRuntimeError,
  ComputeRuntimeProfile,
  type ComputeRuntimePackage,
  type ComputeRuntimeInstallation,
  ComputeRuntimeReadiness,
  ComputeRuntimeSource,
  ComputeRuntimeVerification,
  ComputeTransportKind,
  type ComputeDiscoveryRequest,
  type ComputeLanguageAdapter,
  type ComputeLaunchPlan,
  type ComputeLaunchRequest,
} from "@scientfactory/compute";

import { sanitizeComputeEnvironment, validateProjectRoot } from "./ComputeEnvironmentPolicy.ts";
import { normalizePythonDiagnostic } from "./PythonDiagnostic.ts";
import {
  discoveryContext,
  enumeratePythonRuntimes,
  pathMatches,
  type DiscoveredRuntime,
  type DiscoveryContext,
} from "./RuntimeDiscovery.ts";
import { kernelPrograms } from "./KernelSpecs.ts";
import { readPythonFacts } from "./RuntimeFacts.ts";
import { makeRuntimeProbeCache, type RuntimeProbeCache } from "./RuntimeProbeCache.ts";

export const PYTHON_LANGUAGE_ID = ComputeLanguageId.make("python");
export const JUPYTER_BRIDGE_TRANSPORT_KIND = ComputeTransportKind.make("jupyter-bridge");

// Minimum version requirements (from Phase 2 plan §2.6)

/**
 * 3.10 is the floor because the bridge builds an `asyncio.Event` before a loop
 * is running, which 3.9 rejects outright. Verified against 3.9: the bridge's own
 * unit tests fail to construct it at all.
 */
const MIN_PYTHON_VERSION = "3.10";
const MIN_JUPYTER_CLIENT_VERSION = "8.6";
const MIN_IPYKERNEL_VERSION = "6.29";

/**
 * Reviewed packages used by current compute readiness and the Python Toolkit
 * catalog. The probe stays bounded and does not enumerate an arbitrary user
 * environment.
 */
export const OBSERVED_PYTHON_PACKAGES = [
  "ipykernel",
  "jupyter_client",
  "matplotlib",
  "nbformat",
  "numpy",
  "pandas",
  "plotly",
  "scipy",
  "scikit-learn",
  "seaborn",
  "statsmodels",
  "sympy",
  "openpyxl",
  "pyyaml",
  "pillow",
  "requests",
  "pypdf",
  "tabulate",
  "jinja2",
  "defusedxml",
  "duckdb",
  "xarray",
  "pyarrow",
  "h5py",
  "h5netcdf",
  "zarr",
  "dask",
  "cftime",
  "scikit-image",
  "imageio",
  "tifffile",
  "imagecodecs",
  "biopython",
  "pyfaidx",
] as const;

const ProbeResult = Schema.Struct({
  executable: Schema.String,
  executableRealpath: Schema.String,
  executableMtimeNs: Schema.String,
  implementation: Schema.String,
  version: Schema.String,
  architecture: Schema.NullOr(Schema.String),
  prefix: Schema.String,
  base_prefix: Schema.String,
  platform: Schema.String,
  packages: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
});
export type ProbeResult = typeof ProbeResult.Type;

const decodeProbe = Schema.decodeUnknownSync(ProbeResult);

interface ComparablePythonVersion {
  readonly release: ReadonlyArray<number>;
  readonly prerelease: boolean;
}

/**
 * The readiness gate needs only PEP 440's ordering around a final minimum.
 * Parse that subset explicitly instead of letting `Number("rc1")` become NaN
 * and accidentally treating malformed or pre-release versions as equal.
 */
function parseComparableVersion(value: string): ComparablePythonVersion | null {
  const match =
    /^(\d+(?:\.\d+)*)(?:(a|b|rc)\d+|(?:[._-]?dev)\d*)?(?:(?:[._-]?post)\d*)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i.exec(
      value.trim(),
    );
  if (match === null) return null;
  return {
    release: match[1]!.split(".").map((segment) => Number.parseInt(segment, 10)),
    prerelease: match[2] !== undefined || /(?:^|[._-])dev\d*/i.test(value),
  };
}

function compareVersions(a: ComparablePythonVersion, b: ComparablePythonVersion): number {
  for (let i = 0; i < Math.max(a.release.length, b.release.length); i++) {
    const va = a.release[i] ?? 0;
    const vb = b.release[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return 0;
}

export function meetsPythonMinimumVersion(actual: string, minimum: string): boolean {
  const parsedActual = parseComparableVersion(actual);
  const parsedMinimum = parseComparableVersion(minimum);
  return (
    parsedActual !== null &&
    parsedMinimum !== null &&
    compareVersions(parsedActual, parsedMinimum) >= 0
  );
}

/**
 * A standard-library-only Python script that prints one JSON object describing
 * the interpreter.  Run with `<python> -I -c PROBE_SCRIPT` to avoid project
 * site-packages altering the result.
 */
export const PROBE_SCRIPT = [
  "import importlib.metadata as metadata, json, os, sys, platform",
  "r = {",
  '  "executable": sys.executable,',
  '  "executableRealpath": os.path.realpath(sys.executable),',
  '  "executableMtimeNs": str(os.stat(sys.executable).st_mtime_ns),',
  '  "implementation": platform.python_implementation(),',
  '  "version": platform.python_version(),',
  '  "architecture": platform.machine() or None,',
  '  "prefix": sys.prefix,',
  '  "base_prefix": sys.base_prefix,',
  '  "platform": sys.platform,',
  '  "packages": {},',
  "}",
  `for pkg in ${JSON.stringify(OBSERVED_PYTHON_PACKAGES)}:`,
  "    try:",
  '        r["packages"][pkg] = metadata.version(pkg)',
  "    except metadata.PackageNotFoundError:",
  '        r["packages"][pkg] = None',
  "print(json.dumps(r))",
].join("\n");

// Pure functions (testable without Python)

/**
 * Parses the JSON output of the probe script.
 * @throws on malformed JSON or missing fields.
 */
export function parseProbeOutput(stdout: string): ProbeResult {
  const json = stdout.trim().split("\n").pop();
  if (json === undefined) throw new Error("Probe produced no output.");
  return decodeProbe(JSON.parse(json));
}

/**
 * Checks whether a probe result meets the minimum requirements for the bridge.
 */
export function checkReadiness(
  probe: Pick<ProbeResult, "implementation" | "version" | "packages">,
): {
  readonly readiness: ComputeRuntimeReadiness;
  readonly missing: ReadonlyArray<string>;
} {
  const missing: string[] = [];

  if (probe.implementation !== "CPython") {
    return {
      readiness: "unsupported-version",
      missing: [`CPython required, found ${probe.implementation}`],
    };
  }

  if (
    probe.version !== "unknown" &&
    !meetsPythonMinimumVersion(probe.version, MIN_PYTHON_VERSION)
  ) {
    missing.push(`Python >= ${MIN_PYTHON_VERSION} (found ${probe.version})`);
  }

  for (const [name, minimum] of [
    ["jupyter_client", MIN_JUPYTER_CLIENT_VERSION],
    ["ipykernel", MIN_IPYKERNEL_VERSION],
  ] as const) {
    const version = probe.packages[name];
    // Absent from the record means nothing is known about it.
    if (version === undefined) continue;
    if (version === null) missing.push(name);
    else if (!meetsPythonMinimumVersion(version, minimum))
      missing.push(`${name} >= ${minimum} (found ${version})`);
  }

  if (missing.length > 0) {
    return { readiness: "missing-requirement", missing };
  }

  return { readiness: "ready", missing: [] };
}

/** Stable, sorted package observations safe to expose through runtime inspection. */
function observedPackages(probe: ProbeResult): ReadonlyArray<ComputeRuntimePackage> {
  return OBSERVED_PYTHON_PACKAGES.map((name) => ({
    name,
    version: probe.packages[name] ?? null,
  }));
}

function verificationMessage(
  readiness: ComputeRuntimeReadiness,
  missing: ReadonlyArray<string>,
): string | null {
  if (readiness === "ready") return null;
  if (readiness !== "missing-requirement") return missing.join(", ");

  return [
    `Create or select a Python environment that satisfies: ${missing.join(", ")}.`,
    "Project .venv environments are detected when that project is open.",
    "Scient's isolated compute bridge does not load packages installed with pip --user.",
  ].join(" ");
}

/**
 * Builds a `ComputeRuntimeProfile` from a probe result.
 */
export function buildProfile(
  probe: ProbeResult,
  source: ComputeRuntimeSource,
): ComputeRuntimeProfile {
  return {
    languageId: PYTHON_LANGUAGE_ID,
    source,
    executable: probe.executable,
    languageVersion: probe.version,
    architecture: probe.architecture,
    displayName: `Python ${probe.version} (${source})`,
  };
}

/**
 * Launch the absolute bridge with selected Python -I so project PYTHONPATH, user site packages, and
 * cwd cannot redirect imports. Sanitize inside this sole plan builder so callers cannot bypass
 * environment policy.
 */
export function buildLaunchPlan(
  request: ComputeLaunchRequest,
  bridgePath: string,
): ComputeLaunchPlan {
  const cwd = validateProjectRoot(request.cwd);
  const { environment } = sanitizeComputeEnvironment(request.environment);
  return {
    executable: request.profile.executable,
    args: ["-I", "-u", bridgePath],
    cwd,
    environment,
  };
}

/**
 * Computes a provenance fingerprint from the selected profile and its probe.
 *
 * This is provenance, not a safe verification-cache key: package contents can
 * change without changing the interpreter executable. The short probe cache is
 * only startup deduplication and does not make this a verification-cache key.
 */
export function computeFingerprint(
  profile: ComputeRuntimeProfile,
  probe: ProbeResult,
): ComputeEnvironmentFingerprint {
  const contributors = [
    "executable",
    "executableMtimeNs",
    "languageVersion",
    "architecture",
    "implementation",
    "prefix",
    "basePrefix",
    "platform",
    ...Object.keys(probe.packages).sort(),
  ];
  const data = [
    probe.executableRealpath,
    probe.executableMtimeNs,
    profile.languageVersion,
    profile.architecture ?? "",
    probe.implementation,
    probe.prefix,
    probe.base_prefix,
    probe.platform,
    ...Object.entries(probe.packages)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`),
  ].join("|");
  const hash = NodeCrypto.createHash("sha256").update(data).digest("hex");
  return {
    hash: `sha256:${hash}`,
    contributors,
  };
}

interface ManagedPythonCandidate {
  readonly executable: string;
  readonly selected: boolean;
  /** The person picked it. Otherwise it was selected by being set up on Automatic. */
  readonly chosen?: boolean;
  readonly available?: boolean;
  readonly version?: string;
  /** Why an unavailable managed Python cannot run, when known exactly. */
  readonly problem?: string;
}

const MANAGED_REPAIR = "Scient-managed Python needs repair.";

const REQUIRED_PACKAGES = ["jupyter_client", "ipykernel"] as const;

/**
 * Discovery order with the user's choices placed: a selected managed Python first, then the
 * configured executable, then everything found on disk, with an unselected managed Python last.
 */
export function pythonCandidates(
  found: ReadonlyArray<DiscoveredRuntime>,
  configuredExecutable: string | null,
  managed: ManagedPythonCandidate | null,
): ReadonlyArray<DiscoveredRuntime> {
  const managedCandidate =
    managed === null
      ? []
      : [
          {
            executable: managed.executable,
            source: "managed" as const,
            origin: null,
            problem: managed.available === false ? (managed.problem ?? MANAGED_REPAIR) : null,
          },
        ];
  const configured = configuredExecutable?.trim()
    ? [
        {
          executable: configuredExecutable.trim(),
          source: "configured" as const,
          origin: null,
          problem: null,
        },
      ]
    : [];
  const seen = new Set<string>();
  return [
    ...(managed?.selected === true ? managedCandidate : []),
    ...configured,
    ...found,
    ...(managed?.selected === true ? [] : managedCandidate),
  ].filter((candidate) => {
    if (seen.has(candidate.executable)) return false;
    seen.add(candidate.executable);
    return true;
  });
}

/** Candidates whose problem is known without launching stay visible only when chosen or the project's. */
function keepsUnusableProfile(candidate: DiscoveredRuntime): boolean {
  return (
    candidate.source === "configured" ||
    candidate.source === "managed" ||
    candidate.source === "project"
  );
}

function runtimeError(
  operation: ComputeRuntimeError["operation"],
  message: string,
  cause?: unknown,
): ComputeRuntimeError {
  return new ComputeRuntimeError({ operation, message, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Keep probing as the single injected process boundary so adapter policy can be verified without
 * launching Python.
 */
export function makePythonRuntimeAdapter(
  spawnProbe: (executable: string) => Effect.Effect<string, ComputeRuntimeError>,
  bridgePath: string,
  options: {
    readonly managedRuntime?:
      | (() => Effect.Effect<ManagedPythonCandidate | null, ComputeRuntimeError>)
      | undefined;
    /** Shared by adapters probing the same interpreters, so one probe answers both. */
    readonly probeCache?: RuntimeProbeCache<ProbeResult>;
  } = {},
): ComputeLanguageAdapter {
  const probes = options.probeCache ?? makeRuntimeProbeCache<ProbeResult>();
  /** Why a discovered runtime cannot run, for the verification of its unusable profile. */
  const problems = new Map<string, string>();

  const readProbe = Effect.fn("PythonRuntimeAdapter.readProbe")(function* (executable: string) {
    const probe = yield* probes.get(
      executable,
      spawnProbe(executable).pipe(
        Effect.flatMap((stdout) =>
          Effect.try({
            try: () => parseProbeOutput(stdout),
            catch: (cause) =>
              runtimeError("verify", `Probe output from ${executable} was malformed.`, cause),
          }),
        ),
      ),
    );
    probes.alias(probe.executable, executable);
    return probe;
  });

  const managedCandidate = () =>
    options.managedRuntime === undefined ? Effect.succeed(null) : options.managedRuntime();

  const candidatesFor = Effect.fn("PythonRuntimeAdapter.candidates")(function* (
    request: ComputeDiscoveryRequest,
  ) {
    const context = yield* discoveryContext;
    const windowsRegistrations =
      context.platform === "win32"
        ? yield* Effect.promise(() =>
            context.host.windowsPythonRegistrations(request.refresh === true),
          )
        : [];
    const managed = yield* managedCandidate();
    const enumerated = enumeratePythonRuntimes(context, {
      projectRoot: request.projectRoot,
      windowsRegistrations,
    });
    // An environment registered with `ipykernel install` may live anywhere.
    const known = new Set(enumerated.map((runtime) => runtime.executable));
    const found = [
      ...enumerated,
      ...kernelPrograms(context, "python", (name) => /^python[\d.]*(\.exe)?$/u.test(name))
        .filter(({ executable }) => !known.has(executable))
        .filter(({ executable }) => context.host.isExecutable(executable))
        .map(({ executable, kernel }): DiscoveredRuntime => ({
          executable,
          source: "conventional",
          origin: `Kernel: ${kernel}`,
          problem: null,
        })),
    ];
    return {
      managed,
      found: [...pythonCandidates([], null, managed), ...found],
      candidates: pythonCandidates(found, request.configuredExecutable, managed),
    };
  });

  const unusableProfile = (
    candidate: DiscoveredRuntime,
    problem: string,
  ): ComputeRuntimeProfile => {
    problems.set(candidate.executable, problem);
    return {
      languageId: PYTHON_LANGUAGE_ID,
      source: candidate.source,
      executable: candidate.executable,
      languageVersion: "unknown",
      architecture: null,
      displayName: `Python (${candidate.source}, unavailable)`,
      ...(candidate.origin === null ? {} : { origin: candidate.origin }),
    };
  };

  /** Only files are read here, so looking at a project never runs its interpreter. */
  const profileFromFiles = (
    context: DiscoveryContext,
    candidate: DiscoveredRuntime,
    managedVersion: string | null,
  ): ComputeRuntimeProfile => {
    const version =
      candidate.source === "managed"
        ? managedVersion
        : readPythonFacts(context, candidate.executable).version;
    return {
      languageId: PYTHON_LANGUAGE_ID,
      source: candidate.source,
      executable: candidate.executable,
      languageVersion: version ?? "unknown",
      architecture: null,
      displayName: `Python ${version ?? ""} (${candidate.source})`.replace("  ", " "),
      ...(candidate.origin === null ? {} : { origin: candidate.origin }),
    };
  };

  const discover: ComputeLanguageAdapter["discover"] = Effect.fn("PythonRuntimeAdapter.discover")(
    function* (request) {
      if (request.refresh === true) probes.clear();
      const context = yield* discoveryContext;
      const { candidates, managed } = yield* candidatesFor(request);
      const profiles = candidates.flatMap((candidate) => {
        if (candidate.problem === null) {
          problems.delete(candidate.executable);
          return [profileFromFiles(context, candidate, managed?.version ?? null)];
        }
        return keepsUnusableProfile(candidate)
          ? [unusableProfile(candidate, candidate.problem)]
          : [];
      });
      const seen = new Set<string>();
      return profiles.filter((profile) => {
        if (seen.has(profile.executable)) return false;
        seen.add(profile.executable);
        return true;
      });
    },
  );

  const assess: NonNullable<ComputeLanguageAdapter["assess"]> = Effect.fn(
    "PythonRuntimeAdapter.assess",
  )(function* (profile) {
    const problem = problems.get(profile.executable);
    if (problem !== undefined) return unusableVerification(profile, problem);
    const context = yield* discoveryContext;
    const facts = readPythonFacts(context, profile.executable);
    const observed = Object.fromEntries(
      OBSERVED_PYTHON_PACKAGES.flatMap((name) => {
        const fact = facts.packages(name);
        if (fact.state === "unknown") return [];
        return [[name, fact.state === "present" ? (fact.version ?? "0") : null] as const];
      }),
    );
    const { readiness, missing } = checkReadiness({
      implementation: "CPython",
      version: profile.languageVersion,
      packages: Object.fromEntries(
        REQUIRED_PACKAGES.flatMap((name) => (name in observed ? [[name, observed[name]!]] : [])),
      ),
    });
    return {
      profile,
      readiness,
      ...(readiness === "ready" ? { connection: "detected" as const } : {}),
      missingRequirements: missing,
      message: verificationMessage(readiness, missing),
      packages: Object.entries(observed)
        .map(([name, version]) => ({ name, version: version ?? null }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    } satisfies ComputeRuntimeVerification;
  });

  const unusableVerification = (
    profile: ComputeRuntimeProfile,
    problem: string | undefined,
  ): ComputeRuntimeVerification => ({
    profile,
    readiness: "unusable" as const,
    missingRequirements: [],
    packages: [],
    message:
      profile.source === "managed"
        ? problem !== undefined && problem !== MANAGED_REPAIR
          ? `Scient-managed Python cannot run. ${problem}`
          : "Scient-managed Python is unavailable. Repair it in Scientific Computing settings or choose an existing environment."
        : profile.source === "project"
          ? `The project environment cannot run. ${problem ?? ""}`.trim()
          : problem === undefined
            ? "The selected Python is unavailable. Refresh detection or choose another environment."
            : `This Python cannot run: ${problem}`,
  });

  const verify: ComputeLanguageAdapter["verify"] = Effect.fn("PythonRuntimeAdapter.verify")(
    function* (launchRequest) {
      // Discovery's unavailable placeholder must not be probed: a broken environment's problem is
      // known, and a managed path that failed its ownership check must not be started.
      if (problems.has(launchRequest.profile.executable))
        return unusableVerification(
          launchRequest.profile,
          problems.get(launchRequest.profile.executable),
        );
      const parsed = yield* Effect.result(
        readProbe(launchRequest.profile.executable).pipe(
          Effect.mapError((cause) => runtimeError("verify", cause.message, cause)),
        ),
      );
      if (parsed._tag === "Failure") {
        return {
          profile: launchRequest.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message: `Probe failed: ${parsed.failure.message}`,
          packages: [],
        } satisfies ComputeRuntimeVerification;
      }
      const probe = parsed.success;

      const { readiness, missing } = checkReadiness(probe);

      // `detected` is the MATLAB contract: inspect stays a probe, but
      // `compute.verifyRuntime` will start and close a real session. Omitting
      // it makes Test look like a connection failure and used to send people
      // to Repair.
      return {
        profile: launchRequest.profile,
        readiness,
        ...(readiness === "ready" ? { connection: "detected" as const } : {}),
        missingRequirements: missing,
        message: verificationMessage(readiness, missing),
        packages: observedPackages(probe),
      } satisfies ComputeRuntimeVerification;
    },
  );

  const prepareLaunch: ComputeLanguageAdapter["prepareLaunch"] = (request) =>
    Effect.try({
      try: () => buildLaunchPlan(request, bridgePath),
      catch: (cause) => runtimeError("prepare", "The launch request was not usable.", cause),
    });

  const normalizeDiagnostic: ComputeLanguageAdapter["normalizeDiagnostic"] = (report, context) =>
    normalizePythonDiagnostic(report, context);

  const fingerprintEnvironment: ComputeLanguageAdapter["fingerprintEnvironment"] = Effect.fn(
    "PythonRuntimeAdapter.fingerprintEnvironment",
  )(function* (profile) {
    const probe = yield* readProbe(profile.executable).pipe(
      Effect.mapError((cause) => runtimeError("fingerprint", cause.message, cause)),
    );
    return computeFingerprint(profile, probe);
  });

  return {
    languageId: PYTHON_LANGUAGE_ID,
    transportKind: JUPYTER_BRIDGE_TRANSPORT_KIND,
    selectedExecutable: Effect.fn("PythonRuntimeAdapter.selectedExecutable")(function* (request) {
      const managed = yield* managedCandidate();
      const configured = request.configuredExecutable?.trim() || null;
      // Set up on Automatic stays Automatic. A saved path beside it means the person moved to
      // Scient-managed Python from that path, because Set up never replaces a chosen one.
      return managed?.selected === true && (managed.chosen === true || configured !== null)
        ? managed.executable
        : configured;
    }),
    listInstallations: Effect.fn("PythonRuntimeAdapter.listInstallations")(function* (request) {
      const context = yield* discoveryContext;
      const { managed, found, candidates } = yield* candidatesFor(request);
      const configured = request.configuredExecutable?.trim() || null;
      const configuredFound =
        configured === null
          ? null
          : NodePath.isAbsolute(configured)
            ? configured
            : (pathMatches(context, [configured])[0] ?? null);
      const installations: ComputeRuntimeInstallation[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const resolved =
          candidate.source === "configured"
            ? (configuredFound ?? candidate.executable)
            : candidate.executable;
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        // A chosen executable keeps the provenance it was discovered with.
        const discovered =
          candidate.source === "configured"
            ? found.find((other) => other.executable === resolved)
            : undefined;
        const source = discovered?.source ?? candidate.source;
        const origin = discovered?.origin ?? candidate.origin;
        const missing =
          candidate.source === "configured" &&
          (configuredFound === null || !context.host.isExecutable(configuredFound));
        installations.push({
          executable: resolved,
          source,
          ...(resolved === configuredFound || (missing && candidate.source === "configured")
            ? { configured: true }
            : {}),
          version:
            source === "managed"
              ? (managed?.version ?? null)
              : (readPythonFacts(context, resolved).version ?? null),
          problem: missing ? "The selected Python executable was not found." : candidate.problem,
          ...(origin === null ? {} : { origin }),
        });
      }
      return installations;
    }),
    discover,
    assess,
    verify,
    prepareLaunch,
    normalizeDiagnostic,
    fingerprintEnvironment,
  };
}
