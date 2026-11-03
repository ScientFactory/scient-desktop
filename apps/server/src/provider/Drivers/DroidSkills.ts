import type { ServerProviderMcpServer, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DroidControlError,
  droidControlCall,
  withDroidControl,
  type DroidControlClientFactory,
} from "../droid/DroidControl.ts";

const DroidSkillLocation = Schema.Literals(["project", "personal", "builtin", "automation"]);
const DroidSkillDisabledBy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ledger"),
    sources: Schema.Array(
      Schema.Struct({
        level: Schema.String,
        folderPath: Schema.optional(Schema.String),
      }),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("frontmatter") }),
]);
const DroidSkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: DroidSkillLocation,
  filePath: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  userInvocable: Schema.optional(Schema.Boolean),
  disabledBy: Schema.optional(DroidSkillDisabledBy),
});
const DroidSkillInventory = Schema.Struct({
  skills: Schema.Array(DroidSkillInfo),
  projectAvailable: Schema.optional(Schema.Boolean),
});
const decodeDroidSkillInventory = Schema.decodeUnknownEffect(DroidSkillInventory);
const DroidMcpInventory = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      source: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      toolCount: Schema.optional(Schema.Number),
      requiresAuth: Schema.optional(Schema.Boolean),
      hasAuthTokens: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeDroidMcpInventory = Schema.decodeUnknownOption(DroidMcpInventory);

const DROID_MCP_STATUSES: Readonly<Record<string, ServerProviderMcpServer["status"]>> = {
  connected: "connected",
  connecting: "pending",
  failed: "failed",
  disabled: "disabled",
};

/** The MCP servers Droid configures itself, as Scient Extensions lists native servers. */
function droidMcpServersToServerProvider(raw: unknown): ReadonlyArray<ServerProviderMcpServer> {
  const servers = decodeDroidMcpInventory(raw);
  if (servers._tag === "None") return [];
  return servers.value.servers.flatMap((server) => {
    const name = trimOptional(server.name);
    if (!name) return [];
    const error = trimOptional(server.error);
    const scope = trimOptional(server.source);
    return [
      {
        name,
        status:
          server.requiresAuth && !server.hasAuthTokens && server.status !== "connected"
            ? "needs-auth"
            : (DROID_MCP_STATUSES[server.status] ?? "unknown"),
        ...(scope ? { scope } : {}),
        ...(server.toolCount === undefined ? {} : { toolCount: server.toolCount }),
        ...(error ? { error } : {}),
      },
    ];
  });
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function droidSkillsToServerProviderSkills(
  input: ReadonlyArray<typeof DroidSkillInfo.Type>,
): ReadonlyArray<ServerProviderSkill> {
  const skills: ServerProviderSkill[] = [];
  for (const skill of input) {
    const name = trimOptional(skill.name);
    const path = trimOptional(skill.filePath);
    if (!name || !path) continue;

    const description = trimOptional(skill.description);
    // The level whose settings hold this skill's own state. Scient writes
    // only the user level; a project's level belongs to the project.
    const ownLevel = skill.location === "project" ? "project" : "user";
    const disabledAtAnotherLevel =
      skill.disabledBy?.kind === "ledger" &&
      skill.disabledBy.sources.some((source) => source.level !== ownLevel);
    skills.push({
      name,
      path,
      scope: skill.location,
      enabled: skill.enabled !== false,
      ...(skill.disabledBy?.kind === "frontmatter"
        ? { enabledReadOnlyReason: "Controlled by the skill file" }
        : disabledAtAnotherLevel
          ? { enabledReadOnlyReason: "Managed by another Droid settings level" }
          : ownLevel === "project"
            ? { enabledReadOnlyReason: "Managed in this project" }
            : { canSetEnabled: true }),
      ...(description ? { description, shortDescription: description } : {}),
      ...(skill.userInvocable !== undefined ? { userInvocable: skill.userInvocable } : {}),
    });
  }
  return skills.toSorted(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
}

/** Skills, and the MCP servers Droid configures itself when it lists them. */
export const discoverDroidInventory = Effect.fn("discoverDroidInventory")(function* (
  input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    /**
     * The status probe's session, so one probe starts one Droid session
     * (verified against Droid 0.228.0 and 0.229.0).
     */
    readonly sessionId?: string | undefined;
  },
  makeClient?: DroidControlClientFactory,
) {
  return yield* withDroidControl(
    { ...input, purpose: "its native skill inventory" },
    (client) =>
      droidControlCall("Droid failed to list its native skill inventory.", client.listSkills).pipe(
        Effect.flatMap((raw) =>
          decodeDroidSkillInventory(raw).pipe(
            Effect.mapError(
              (cause) =>
                new DroidControlError({
                  cause,
                  detail: "Droid returned an invalid native skill inventory.",
                }),
            ),
          ),
        ),
        Effect.map((inventory) => droidSkillsToServerProviderSkills(inventory.skills)),
        Effect.flatMap((skills) =>
          Effect.tryPromise(client.listMcpServers).pipe(
            Effect.map(droidMcpServersToServerProvider),
            Effect.option,
            Effect.map((mcpServers) => ({
              skills,
              mcpServers: mcpServers._tag === "Some" ? mcpServers.value : undefined,
            })),
          ),
        ),
      ),
    makeClient,
  );
});

/**
 * Refuse project skill writes from this server-cwd session: Droid would update server project
 * settings and leave the intended project's skill unchanged. Only user-level skills are writable
 * here.
 */
export const setDroidSkillEnabled = Effect.fn("setDroidSkillEnabled")(function* (
  input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly name: string;
    readonly scope?: string | undefined;
    readonly enabled: boolean;
  },
  makeClient?: DroidControlClientFactory,
) {
  if (input.scope === "project") {
    return yield* new DroidControlError({
      detail: `Droid project skills are managed in the project. Change '${input.name}' there.`,
    });
  }
  return yield* withDroidControl(
    { ...input, purpose: "native skill settings" },
    (client) =>
      droidControlCall(
        `Droid failed to ${input.enabled ? "enable" : "disable"} '${input.name}'.`,
        () => client.setSkillDisabled(input.name, !input.enabled),
      ).pipe(Effect.as({ effectiveEnabled: input.enabled })),
    makeClient,
  );
});
