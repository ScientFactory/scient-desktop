/** Native skill inventory for the legacy `agy` Antigravity runtime. */
import * as NodeOS from "node:os";

import type { AntigravitySettings, ServerProviderSkill } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

const SKILLS_PROBE_TIMEOUT_MS = 15_000;
const SKILLS_OUTPUT_LIMIT = 2_000_000;

const NativeSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.String,
  builtin: Schema.optional(Schema.Boolean),
  plugin: Schema.optional(Schema.NullOr(Schema.String)),
  model_invocable: Schema.optional(Schema.Boolean),
});

const NativeSkillsResponse = Schema.fromJsonString(
  Schema.Struct({
    command: Schema.Struct({
      name: Schema.String,
      data: Schema.Struct({ skills: Schema.Array(NativeSkill) }),
    }),
  }),
);
const decodeNativeSkillsResponse = Schema.decodeUnknownEffect(NativeSkillsResponse);

export class LegacyAntigravitySkillsProbeError extends Schema.TaggedError<LegacyAntigravitySkillsProbeError>()(
  "LegacyAntigravitySkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "output-limit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `Antigravity native skill discovery failed during ${this.stage}${location}${exitCode}.`;
  }
}

function pathIsWithin(path: Path.Path, candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Ask the selected `agy` runtime for the exact catalog it loaded. Machine-level
 * discovery keeps only global entries; a workspace probe also retains entries
 * rooted in that workspace. Plugin and built-in metadata comes from the CLI,
 * rather than inferred installation paths.
 */
export const discoverAntigravitySkills = Effect.fn("discoverLegacyAntigravitySkills")(function* (
  settings: Pick<AntigravitySettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const path = yield* Path.Path;
  const command = settings.binaryPath || "agy";
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["-p", "/skills", "--output-format", "json", "--print-timeout", "10s"],
      { env: environment },
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : { cwd: NodeOS.tmpdir() }),
        env: environment,
        shell: spawnCommand.shell,
        stdin: "ignore",
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyAntigravitySkillsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(result)) {
    return yield* new LegacyAntigravitySkillsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  if (result.value.code !== 0) {
    return yield* new LegacyAntigravitySkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: result.value.code,
    });
  }
  if (result.value.stdout.length > SKILLS_OUTPUT_LIMIT) {
    return yield* new LegacyAntigravitySkillsProbeError({
      stage: "output-limit",
      ...(cwd ? { cwd } : {}),
    });
  }

  const decoded = yield* decodeNativeSkillsResponse(result.value.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyAntigravitySkillsProbeError({
          stage: "decode",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
  );
  if (decoded.command.name !== "skills") {
    return yield* new LegacyAntigravitySkillsProbeError({
      stage: "decode",
      ...(cwd ? { cwd } : {}),
    });
  }

  const userHome = path.resolve(environment.HOME?.trim() || NodeOS.homedir());
  const globalGeminiDirectory = path.join(userHome, ".gemini");
  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of decoded.command.data.skills) {
    const name = entry.name.trim();
    const skillPath = entry.path.trim();
    if (!name || !skillPath) continue;

    const plugin = entry.plugin?.trim();
    const isProjectSkill = cwd !== undefined && pathIsWithin(path, skillPath, path.resolve(cwd));
    const isGlobalSkill =
      entry.builtin === true ||
      Boolean(plugin) ||
      pathIsWithin(path, skillPath, globalGeminiDirectory);
    if (!isProjectSkill && !isGlobalSkill) continue;

    const description = entry.description?.trim();
    const scope =
      entry.builtin === true ? "app" : plugin ? "plugin" : isProjectSkill ? "project" : "user";
    skillsByName.set(name, {
      name,
      path: skillPath,
      scope,
      enabled: true,
      ...(description ? { description } : {}),
      ...(entry.model_invocable === false ? { userInvocationOnly: true } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
