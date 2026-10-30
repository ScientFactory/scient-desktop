// @effect-diagnostics nodeBuiltinImport:off -- kernelspec identities are hashed host paths.
import * as NodeCrypto from "node:crypto";

import {
  ComputeLanguageId,
  ComputeRuntimeError,
  computeLanguageIdFromName,
  REQUIRED_COMPUTE_CAPABILITIES,
  type ComputeLanguageAdapter,
  type ComputeRuntimeInstallation,
  type ComputeRuntimeProfile,
} from "@scientfactory/compute";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import type { KernelBridgeHost } from "./PythonComputeRuntime.ts";
import { normalizeDiagnosticText } from "./PythonDiagnostic.ts";
import { JUPYTER_BRIDGE_TRANSPORT_KIND, buildLaunchPlan } from "./PythonRuntimeAdapter.ts";
import {
  discoveryContext,
  enumeratePythonRuntimes,
  pathMatches,
  pathModule,
  type DiscoveryContext,
} from "./RuntimeDiscovery.ts";

/** Languages with their own adapter; their kernels are not offered a second time. */
const CURATED_LANGUAGES: ReadonlySet<string> = new Set(["python", "r", "julia", "matlab", "sql"]);
const MAX_KERNELS = 64;

const KernelJson = Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  display_name: Schema.String,
  language: Schema.NonEmptyString,
  interrupt_mode: Schema.optional(Schema.Literals(["signal", "message"])),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeKernelJson = Schema.decodeUnknownOption(Schema.fromJsonString(KernelJson));

/** One installed kernel; its directory is its identity, so two `python3` specs never merge. */
export interface InstalledKernelSpec {
  readonly name: string;
  readonly resourceDir: string;
  readonly displayName: string;
  readonly language: string;
  readonly argv: ReadonlyArray<string>;
  readonly interruptMode: "signal" | "message";
  readonly env: Readonly<Record<string, string>>;
}

interface KernelLanguage {
  readonly name: string;
  readonly extension?: string;
  /** Present on the languages Scient always lists, installed or not. */
  readonly setup?: { readonly needs: string; readonly url?: string };
}

const KERNEL_LANGUAGES: Readonly<Record<string, KernelLanguage>> = {
  bash: { name: "Bash", extension: ".sh" },
  clojure: { name: "Clojure", extension: ".clj" },
  cpp: { name: "C++", extension: ".cpp" },
  csharp: { name: "C#", extension: ".cs" },
  fsharp: { name: "F#", extension: ".fsx" },
  go: { name: "Go", extension: ".go" },
  haskell: { name: "Haskell", extension: ".hs" },
  java: { name: "Java", extension: ".java" },
  javascript: { name: "JavaScript", extension: ".js" },
  kotlin: { name: "Kotlin", extension: ".kts" },
  lean: { name: "Lean", extension: ".lean" },
  lua: { name: "Lua", extension: ".lua" },
  ocaml: { name: "OCaml", extension: ".ml" },
  octave: {
    name: "GNU Octave",
    setup: {
      needs: "GNU Octave and octave_kernel",
      url: "https://github.com/Calysto/octave_kernel",
    },
  },
  powershell: { name: "PowerShell", extension: ".ps1" },
  ruby: { name: "Ruby", extension: ".rb" },
  rust: {
    name: "Rust",
    extension: ".rs",
    setup: {
      needs: "The evcxr kernel: cargo install --locked evcxr_jupyter, then evcxr_jupyter --install",
      url: "https://github.com/evcxr/evcxr/tree/main/evcxr_jupyter",
    },
  },
  scala: { name: "Scala", extension: ".scala" },
  spss: {
    name: "SPSS",
    extension: ".sps",
    setup: { needs: "Not supported yet: SPSS has no Jupyter kernel" },
  },
  stata: {
    name: "Stata",
    extension: ".do",
    setup: { needs: "Stata 17 or later and nbstata", url: "https://hugetim.github.io/nbstata/" },
  },
  typescript: { name: "TypeScript", extension: ".ts" },
  "wolfram-language": {
    name: "Wolfram Language",
    extension: ".wl",
    setup: {
      needs: "Wolfram Engine and WolframLanguageForJupyter",
      url: "https://github.com/WolframResearch/WolframLanguageForJupyter",
    },
  },
};

/** Jupyter's search order: JUPYTER_PATH, the user's data directory, environment prefixes, system. */
export function jupyterKernelDirectories(
  context: DiscoveryContext,
  prefixes: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  const env = context.environment;
  const home = context.homeDirectory;
  const user =
    env.JUPYTER_DATA_DIR ??
    (context.platform === "darwin"
      ? path.join(home, "Library", "Jupyter")
      : context.platform === "win32"
        ? path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "jupyter")
        : path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "jupyter"));
  const system =
    context.platform === "win32"
      ? [path.join(env.PROGRAMDATA ?? "C:\\ProgramData", "jupyter")]
      : ["/usr/local/share/jupyter", "/usr/share/jupyter"];
  return [
    ...(env.JUPYTER_PATH ?? "")
      .split(context.platform === "win32" ? ";" : ":")
      .filter((entry) => entry.length > 0),
    user,
    ...prefixes.map((prefix) => path.join(prefix, "share", "jupyter")),
    ...system,
  ].map((directory) => path.join(directory, "kernels"));
}

/** Reads kernel.json files only; nothing is launched. */
function readInstalledKernelSpecs(
  context: DiscoveryContext,
  directories: ReadonlyArray<string>,
): ReadonlyArray<InstalledKernelSpec> {
  const path = pathModule(context.platform);
  const seen = new Set<string>();
  const specs: InstalledKernelSpec[] = [];
  for (const directory of directories) {
    for (const name of context.host.readDirectory(directory).toSorted()) {
      const resourceDir = path.join(directory, name);
      const key = context.platform === "win32" ? resourceDir.toLowerCase() : resourceDir;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = context.host.readText(path.join(resourceDir, "kernel.json"));
      if (text === null) continue;
      const parsed = decodeKernelJson(text);
      if (parsed._tag === "None") continue;
      specs.push({
        name,
        resourceDir,
        displayName: parsed.value.display_name || name,
        language: parsed.value.language,
        argv: parsed.value.argv,
        interruptMode: parsed.value.interrupt_mode ?? "signal",
        env: parsed.value.env ?? {},
      });
      if (specs.length >= MAX_KERNELS) return specs;
    }
  }
  return specs;
}

/** Kernels in the standard locations and in every Python environment discovery can see. */
const installedSpecs = Effect.fn("InstalledKernelRuntime.installedSpecs")(function* (
  projectRoot: string | null,
) {
  const context = yield* discoveryContext;
  const path = pathModule(context.platform);
  const windowsRegistrations =
    context.platform === "win32"
      ? yield* Effect.promise(() => context.host.windowsPythonRegistrations())
      : [];
  const prefixes = enumeratePythonRuntimes(context, { projectRoot, windowsRegistrations })
    .filter((runtime) => runtime.problem === null)
    .map((runtime) => {
      const directory = path.dirname(runtime.executable);
      return context.platform === "win32" && path.basename(directory).toLowerCase() !== "scripts"
        ? directory
        : path.dirname(directory);
    });
  return {
    context,
    specs: readInstalledKernelSpecs(
      context,
      jupyterKernelDirectories(context, [...new Set(prefixes)]),
    ),
  };
});

/**
 * The languages with a setup entry, then any other kernel language installed now. The first group
 * is bound whether or not it is installed, so its kernel is found without a restart.
 */
export const kernelLanguages = Effect.fn("InstalledKernelRuntime.languages")(function* () {
  const specs = yield* installedSpecs(null).pipe(
    Effect.map((installed) => installed.specs),
    Effect.catchCause((cause) =>
      Effect.logWarning("installed Jupyter kernels are unavailable", { cause }).pipe(Effect.as([])),
    ),
  );
  const languages = new Map(
    Object.entries(KERNEL_LANGUAGES).flatMap(([languageId, known]) =>
      known.setup === undefined ? [] : [[languageId, known.name] as const],
    ),
  );
  for (const spec of specs) {
    const languageId = computeLanguageIdFromName(spec.language);
    if (!CURATED_LANGUAGES.has(languageId) && !languages.has(languageId))
      languages.set(languageId, spec.language);
  }
  return [...languages].map(([languageId, language]) => {
    const known = KERNEL_LANGUAGES[languageId];
    return {
      languageId: ComputeLanguageId.make(languageId),
      displayName: known?.name ?? language,
      sourceExtensions: known?.extension ? [known.extension] : [],
      ...(known?.setup ? { setup: known.setup } : {}),
    };
  });
});

function runtimeError(
  operation: ComputeRuntimeError["operation"],
  message: string,
  cause?: unknown,
): ComputeRuntimeError {
  return new ComputeRuntimeError({ operation, message, ...(cause === undefined ? {} : { cause }) });
}

/**
 * A bare `python` in a kernelspec means the Python the kernel was installed for, but Jupyter would
 * put its own in its place, and the bridge's Python does not have the kernel's package.
 */
export function kernelLaunch(
  context: DiscoveryContext,
  spec: InstalledKernelSpec,
): Pick<InstalledKernelSpec, "argv" | "env"> {
  const [program, ...rest] = spec.argv;
  if (program !== "python" && program !== "python3") return spec;
  const path = pathModule(context.platform);
  const windows = context.platform === "win32";
  const prefix = path.resolve(spec.resourceDir, "..", "..", "..", "..");
  const local = (
    windows
      ? [path.join(prefix, "python.exe"), path.join(prefix, "Scripts", "python.exe")]
      : [path.join(prefix, "bin", "python3"), path.join(prefix, "bin", "python")]
  ).find((candidate) => context.host.isExecutable(candidate));
  if (local !== undefined) {
    const currentPath = context.environment.PATH ?? context.environment.Path;
    return {
      argv: [local, ...rest],
      env: {
        ...spec.env,
        PATH: [path.dirname(local), ...(currentPath ? [currentPath] : [])].join(path.delimiter),
      },
    };
  }
  const onPath = pathMatches(context, windows ? ["python.exe"] : ["python3", "python"])[0];
  return onPath === undefined ? spec : { argv: [onPath, ...rest], env: spec.env };
}

/** Whether a kernel's own program is present, without running it. */
function kernelProgramPresent(context: DiscoveryContext, spec: InstalledKernelSpec): boolean {
  const path = pathModule(context.platform);
  const program = kernelLaunch(context, spec).argv[0]!.replaceAll(
    "{resource_dir}",
    spec.resourceDir,
  );
  if (path.isAbsolute(program)) return context.host.isExecutable(program);
  const names =
    context.platform === "win32" && path.extname(program) === ""
      ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`]
      : [program];
  return pathMatches(context, names).length > 0;
}

/**
 * Any installed Jupyter kernel behind the existing bridge. Its capabilities are only what every
 * kernel provides: there is no variables or table inspection for a language Scient does not know.
 */
export const makeInstalledKernelBinding = Effect.fn("InstalledKernelRuntime.makeBinding")(
  function* (
    language: {
      readonly languageId: ComputeLanguageId;
      readonly displayName: string;
      readonly sourceExtensions: ReadonlyArray<string>;
      readonly setup?: KernelLanguage["setup"];
    },
    input: {
      readonly host: Pick<KernelBridgeHost, "bridgePath" | "transport" | "executable">;
      readonly configuredExecutable: (languageId: string) => Effect.Effect<string | null>;
    },
  ): Effect.fn.Return<ComputeRuntimeBinding> {
    const known = new Map<string, InstalledKernelSpec>();

    const specsFor = Effect.fn("InstalledKernelRuntime.specs")(function* (
      projectRoot: string | null,
    ) {
      const { context, specs } = yield* installedSpecs(projectRoot);
      const mine = specs.filter(
        (spec) => computeLanguageIdFromName(spec.language) === language.languageId,
      );
      for (const spec of mine) known.set(spec.resourceDir, spec);
      return { context, specs: mine };
    });

    const profileFor = (
      spec: InstalledKernelSpec,
      projectRoot: string | null,
      context: DiscoveryContext,
    ): ComputeRuntimeProfile => {
      const path = pathModule(context.platform);
      const inProject =
        projectRoot !== null && !path.relative(projectRoot, spec.resourceDir).startsWith("..");
      return {
        languageId: language.languageId,
        source: inProject ? "project" : "conventional",
        executable: spec.resourceDir,
        languageVersion: "unknown",
        architecture: null,
        displayName: spec.displayName,
        origin: spec.name,
      };
    };

    const missingProfile = (executable: string): ComputeRuntimeProfile => ({
      languageId: language.languageId,
      source: "configured",
      executable,
      languageVersion: "unknown",
      architecture: null,
      displayName: `${language.displayName} (configured, not found)`,
    });

    const discover: ComputeLanguageAdapter["discover"] = Effect.fn(
      "InstalledKernelRuntime.discover",
    )(function* (request) {
      const { context, specs } = yield* specsFor(request.projectRoot);
      const configured = request.configuredExecutable?.trim() || null;
      const profiles = specs.map((spec) => profileFor(spec, request.projectRoot, context));
      return configured !== null && !specs.some((spec) => spec.resourceDir === configured)
        ? [missingProfile(configured), ...profiles]
        : profiles;
    });

    const verify: ComputeLanguageAdapter["verify"] = Effect.fn("InstalledKernelRuntime.verify")(
      function* (request) {
        const context = yield* discoveryContext;
        const spec = known.get(request.profile.executable);
        const unusable = (message: string) => ({
          profile: request.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message,
          packages: [],
        });
        if (spec === undefined) return unusable("This kernel is no longer installed.");
        if (!kernelProgramPresent(context, spec))
          return unusable(`The kernel's program ${spec.argv[0]} was not found.`);
        const host = yield* Effect.result(
          input.host.executable(yield* input.configuredExecutable("python")),
        );
        if (host._tag === "Failure")
          return {
            ...unusable(host.failure.message),
            readiness: "missing-requirement" as const,
            missingRequirements: ["Python with jupyter_client"],
          };
        // Discovery read files only; Test and the first Run are the one real launch.
        return {
          profile: request.profile,
          readiness: "ready" as const,
          connection: "detected" as const,
          missingRequirements: [],
          message: null,
          packages: [],
        };
      },
    );

    const prepareLaunch: ComputeLanguageAdapter["prepareLaunch"] = Effect.fn(
      "InstalledKernelRuntime.prepareLaunch",
    )(function* (request) {
      const spec = known.get(request.profile.executable);
      if (spec === undefined)
        return yield* runtimeError("prepare", "This kernel is no longer installed.");
      const host = yield* input.host.executable(yield* input.configuredExecutable("python"));
      const launch = kernelLaunch(yield* discoveryContext, spec);
      const plan = yield* Effect.try({
        try: () =>
          buildLaunchPlan(
            {
              profile: { ...request.profile, executable: host },
              cwd: request.cwd,
              environment: request.environment,
            },
            input.host.bridgePath,
          ),
        catch: (cause) => runtimeError("prepare", "The launch request was not usable.", cause),
      });
      return {
        ...plan,
        kernel: {
          argv: launch.argv,
          language: spec.language,
          interruptMode: spec.interruptMode,
          variablesExpression: null,
          env: launch.env,
          resourceDir: spec.resourceDir,
        },
      };
    });

    const fingerprintEnvironment: ComputeLanguageAdapter["fingerprintEnvironment"] = (profile) => {
      const spec = known.get(profile.executable);
      if (spec === undefined)
        return Effect.fail(runtimeError("fingerprint", "This kernel is no longer installed."));
      const data = JSON.stringify([spec.resourceDir, spec.argv, spec.env, spec.interruptMode]);
      return Effect.succeed({
        hash: `sha256:${NodeCrypto.createHash("sha256").update(data).digest("hex")}`,
        contributors: ["resourceDir", "argv", "env", "interruptMode"],
      });
    };

    const listInstallations: NonNullable<ComputeLanguageAdapter["listInstallations"]> = Effect.fn(
      "InstalledKernelRuntime.listInstallations",
    )(function* (request) {
      const { specs } = yield* specsFor(request.projectRoot);
      const configured = request.configuredExecutable?.trim() || null;
      const rows: ComputeRuntimeInstallation[] = specs.map((spec) => ({
        executable: spec.resourceDir,
        source: "conventional",
        ...(spec.resourceDir === configured ? { configured: true } : {}),
        version: null,
        problem: null,
        origin: spec.displayName,
      }));
      return configured !== null && !specs.some((spec) => spec.resourceDir === configured)
        ? [
            {
              executable: configured,
              source: "configured",
              configured: true,
              version: null,
              problem: "The selected kernel is no longer installed.",
            },
            ...rows,
          ]
        : rows;
    });

    return {
      adapter: {
        languageId: language.languageId,
        transportKind: JUPYTER_BRIDGE_TRANSPORT_KIND,
        listInstallations,
        discover,
        verify,
        prepareLaunch,
        normalizeDiagnostic: (report) => [{ ...normalizeDiagnosticText(report), frames: [] }],
        fingerprintEnvironment,
      },
      transport: input.host.transport(),
      descriptor: {
        languageId: language.languageId,
        displayName: language.displayName,
        sourceExtensions: language.sourceExtensions,
        capabilities: [...REQUIRED_COMPUTE_CAPABILITIES],
        ...(language.setup ? { setup: language.setup } : {}),
      },
    };
  },
);
