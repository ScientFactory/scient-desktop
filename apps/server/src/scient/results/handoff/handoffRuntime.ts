// @effect-diagnostics nodeBuiltinImport:off -- a verified source and explicit executable use host paths.
import * as NodeCrypto from "node:crypto";

import { ExecutionRunId } from "@scientfactory/execution";
import type { ResultHandoffManifest, ResultHandoffVerification } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { RESULTS_FOLDER_VARIABLE } from "@t3tools/shared/computeResults";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { sanitizeComputeEnvironment } from "../../compute/ComputeEnvironmentPolicy.ts";
import type { ExecutionProcess } from "../../execution/LocalExecutionProcess.ts";
import { handoffRefusal, isHandoffRefusal, packagePath } from "./handoffFiles.ts";
import type { VerifiedPackageFiles } from "./verificationFiles.ts";

const decodePythonEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const PYTHON_ENVIRONMENT = `
import importlib.metadata
import json
import platform
from itertools import islice
packages = [
    {"name": entry.metadata.get("Name"), "version": entry.version}
    for entry in islice(importlib.metadata.distributions(), 4000)
]
print(json.dumps({"version": platform.python_version(), "packages": packages}))
`;

const NOTEBOOK = `
import json
import pathlib
import sys
from IPython.core.interactiveshell import InteractiveShell

source = pathlib.Path(sys.argv[1])
sys.argv[:] = [str(source)]
sys.path.insert(0, str(source.parent))
notebook = json.loads(source.read_text(encoding="utf-8"))
shell = InteractiveShell.instance()
for cell in notebook["cells"]:
    if cell["cell_type"] == "code":
        result = shell.run_cell("".join(cell["source"]))
        result.raise_error()
`;

function packageRuntime(manifest: ResultHandoffManifest, source: string, platform: string) {
  const language = manifest.source.language.toLowerCase();
  if (language === "python") {
    return {
      command: platform === "win32" ? "python" : "python3",
      args: manifest.source.kind === "notebook" ? ["-c", NOTEBOOK, source] : [source],
    };
  }
  if (manifest.source.kind === "script" && language === "r") {
    return { command: "Rscript", args: ["--vanilla", source] };
  }
  if (manifest.source.kind === "script" && language === "julia") {
    return { command: "julia", args: ["--startup-file=no", "--history-file=no", source] };
  }
  throw handoffRefusal(
    "Verification supports Python scripts and notebooks, and R and Julia scripts.",
  );
}

function overrideJson(
  manifest: Pick<ResultHandoffManifest, "parameters" | "source">,
): string | undefined {
  const pairs = new Map<string, string>();
  for (const parameter of manifest.parameters ?? []) {
    if (parameter.source !== "override") continue;
    const validated: unknown = JSON.parse(parameter.value);
    if (validated === undefined) throw handoffRefusal("A recorded parameter is invalid.");
    pairs.set(parameter.name, parameter.value);
  }
  return pairs.size === 0 && manifest.source.kind !== "notebook"
    ? undefined
    : `{${Array.from(pairs, ([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
}

const runCommand = Effect.fn("ResultHandoff.runCommand")(function* (
  process: ExecutionProcess["Service"],
  invocation: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly capture?: number;
  },
) {
  const handle = yield* process.start({
    ...invocation,
    runId: ExecutionRunId.make(NodeCrypto.randomUUID()),
    extendEnv: false,
  });
  let transcript = "";
  const drain = handle.output.pipe(
    Stream.runForEach(({ text }) =>
      Effect.sync(() => {
        transcript += text.slice(0, Math.max(0, (invocation.capture ?? 0) - transcript.length));
      }),
    ),
  );
  const [exitCode] = yield* Effect.all([handle.exitCode, drain], { concurrency: "unbounded" });
  return { exitCode, transcript };
}, Effect.scoped);

export const runPackage = Effect.fn("ResultHandoff.runPackage")(function* (
  process: ExecutionProcess["Service"],
  manifest: ResultHandoffManifest,
  files: VerifiedPackageFiles,
  requestedExecutable: string | undefined,
  timeoutMinutes: number,
) {
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const host = yield* HostProcess.Environment;
  const source = packagePath(files.workspace, manifest.source.path);
  const { command, args } = yield* Effect.try({
    try: () => packageRuntime(manifest, source, platform),
    catch: (cause) =>
      handoffRefusal(
        isHandoffRefusal(cause) ? cause.message : "The source runtime could not be selected.",
      ),
  });
  const parameters = yield* Effect.try({
    try: () => overrideJson(manifest),
    catch: () => handoffRefusal("A recorded parameter is invalid."),
  });
  const { environment } = sanitizeComputeEnvironment(
    Object.fromEntries(
      Object.entries(host).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  );
  const executable = requestedExecutable ?? command;
  const invocation = { executable, cwd: files.workspace, environment };
  const python = manifest.source.language.toLowerCase() === "python";
  const probe = yield* runCommand(process, {
    ...invocation,
    args: python ? ["-I", "-c", PYTHON_ENVIRONMENT] : ["--version"],
    capture: 512 * 1024,
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(() =>
      handoffRefusal(
        "The selected runtime did not start. Choose an installed executable on the Compute computer.",
      ),
    ),
  );
  if (probe.exitCode !== 0) {
    return yield* handoffRefusal(
      "The selected runtime did not report its version. Choose a working executable.",
    );
  }
  const portableText = (value: unknown): value is string =>
    typeof value === "string" && /^[\w.+ ()!-]{1,120}$/u.test(value);
  let version =
    probe.transcript
      .trim()
      .split(/\r?\n/u)[0]
      ?.match(/^[\w.+ ()-]{1,120}$/u)?.[0] ?? null;
  let packages: ReadonlyArray<{ name: string; version: string }> | undefined;
  if (python) {
    const evidence = yield* decodePythonEvidence(probe.transcript).pipe(
      Effect.mapError(() =>
        handoffRefusal("The selected Python could not report its environment."),
      ),
    );
    if (
      typeof evidence === "object" &&
      evidence !== null &&
      "version" in evidence &&
      portableText(evidence.version) &&
      "packages" in evidence &&
      Array.isArray(evidence.packages)
    ) {
      version = evidence.version;
      const entries: ReadonlyArray<unknown> = evidence.packages;
      packages = entries.flatMap((entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        portableText(entry.name) &&
        "version" in entry &&
        portableText(entry.version)
          ? [{ name: entry.name, version: entry.version }]
          : [],
      );
    }
  }
  const { locale, timeZone: timezone } = Intl.DateTimeFormat().resolvedOptions();
  const observed: NonNullable<ResultHandoffVerification["environment"]> = {
    language: manifest.source.language,
    version,
    platform,
    architecture,
    locale,
    timezone,
    ...(packages === undefined ? {} : { packages }),
  };

  const ran = yield* runCommand(process, {
    ...invocation,
    args,
    environment: {
      ...environment,
      [RESULTS_FOLDER_VARIABLE]: files.results,
      ...(python ? { PYTHONPATH: files.workspace } : {}),
      ...(parameters === undefined ? {} : { SCIENT_PARAMETERS: parameters }),
    },
  }).pipe(
    Effect.timeout(Duration.minutes(timeoutMinutes)),
    Effect.match({
      onFailure: (failure) =>
        failure._tag === "TimeoutError"
          ? `The rerun exceeded its ${timeoutMinutes}-minute time limit.`
          : "The source did not finish. The selected runtime could not start or was interrupted.",
      onSuccess: ({ exitCode }) =>
        exitCode === 0
          ? null
          : manifest.source.kind === "notebook"
            ? `The notebook exited with code ${exitCode}. Check the selected Python has IPython and the notebook's dependencies.`
            : `The source exited with code ${exitCode}. Check its dependencies and try the recorded runtime version.`,
    }),
  );
  return { environment: observed, problem: ran };
});
