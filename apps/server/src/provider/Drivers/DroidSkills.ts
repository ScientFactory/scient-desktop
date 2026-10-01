import type { ServerProviderSkill } from "@t3tools/contracts";
import { DroidClient, ProcessTransport, SettingsLevel } from "@factory/droid-sdk/node";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

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

const DROID_SKILL_DISCOVERY_ERROR_TAG = "DroidSkillDiscoveryError";
class DroidSkillDiscoveryError extends Data.TaggedError(DROID_SKILL_DISCOVERY_ERROR_TAG)<{
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = Predicate.isTagged(DROID_SKILL_DISCOVERY_ERROR_TAG);
}

export interface DroidSkillInventoryClient {
  readonly close: () => Promise<void>;
  readonly listSkills: () => Promise<unknown>;
  /** Records the choice in Droid's user-level settings. */
  readonly setSkillDisabled?: (skillName: string, disabled: boolean) => Promise<void>;
}

export type DroidSkillInventoryClientFactory = (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** An existing session to read from; otherwise the client starts a new one. */
  readonly sessionId?: string | undefined;
  readonly signal: AbortSignal;
}) => Promise<DroidSkillInventoryClient>;

// Deliberately use the official SDK's transport and protocol client instead of
// its high-level createSession helper. The helper requires FACTORY_API_KEY,
// while Scient also supports Droid's existing subscription login. The lower
// level client preserves that login and still owns framing, request matching,
// protocol compatibility, process cleanup, and cross-platform spawning.
const liveDroidSkillInventoryClient: DroidSkillInventoryClientFactory = async (input) => {
  const transport = new ProcessTransport({
    droidExecPath: input.binaryPath,
    cwd: input.cwd,
    // The SDK spreads the server's environment under this one. Undefined
    // entries mask what the agent environment contract removed; Node omits them.
    env: input.environment as Record<string, string>,
  });
  let client: DroidClient | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (client ? client.close() : transport.close()).finally(() => {
      input.signal.removeEventListener("abort", onAbort);
    });
    return closePromise;
  };
  const onAbort = () => {
    void close();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    await transport.connect();
    // The SDK rejects a failed write through its own promise and leaves the
    // stream's error event unhandled: a Droid that exits before a request is
    // written would end the server with an uncaught EPIPE.
    transport.getManagedProcess()?.childProcess.stdin?.on("error", () => undefined);
    client = new DroidClient({ transport });
    // Loading the status probe's session lists the same skills without starting
    // another session (verified against Droid 0.228.0 and 0.229.0).
    const opened = input.sessionId
      ? await client.loadSession({ sessionId: input.sessionId })
      : await client.initializeSession({
          machineId: "scient-provider-skill-inventory",
          cwd: input.cwd,
        });
    if (opened.error) {
      throw new Error(opened.error.message);
    }
  } catch (cause) {
    await close().catch(() => undefined);
    throw cause;
  }

  return {
    close,
    listSkills: async () => {
      if (!client) throw new Error("Droid skill inventory client is not initialized.");
      const response = await client.listSkills();
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.result;
    },
    setSkillDisabled: async (skillName, disabled) => {
      if (!client) throw new Error("Droid skill inventory client is not initialized.");
      const response = await client.setSkillDisabled(skillName, disabled, SettingsLevel.User);
      if (response.error) {
        throw new Error(response.error.message);
      }
    },
  };
};

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
    // only the user level; a project's level belongs to the project, whose
    // settings Droid writes relative to its working directory (see
    // setDroidSkillEnabled).
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

export const discoverDroidSkills = Effect.fn("discoverDroidSkills")(function* (
  input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    /** The status probe's session, so one probe starts one Droid session. */
    readonly sessionId?: string | undefined;
  },
  makeClient: DroidSkillInventoryClientFactory = liveDroidSkillInventoryClient,
) {
  const client = yield* Effect.tryPromise({
    try: (signal) => makeClient({ ...input, signal }),
    catch: (cause) =>
      new DroidSkillDiscoveryError({
        cause,
        detail: "Failed to start Droid's native skill inventory session.",
      }),
  });

  return yield* Effect.acquireUseRelease(
    Effect.succeed(client),
    (acquired) =>
      Effect.tryPromise({
        try: () => acquired.listSkills(),
        catch: (cause) =>
          new DroidSkillDiscoveryError({
            cause,
            detail: "Droid failed to list its native skill inventory.",
          }),
      }).pipe(
        Effect.flatMap(decodeDroidSkillInventory),
        Effect.map((inventory) => droidSkillsToServerProviderSkills(inventory.skills)),
        Effect.mapError((cause) =>
          DroidSkillDiscoveryError.is(cause)
            ? cause
            : new DroidSkillDiscoveryError({
                cause,
                detail: "Droid returned an invalid native skill inventory.",
              }),
        ),
      ),
    (acquired) =>
      Effect.promise(() => acquired.close()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to close Droid's native skill inventory session.", { cause }),
        ),
      ),
  );
});

/**
 * Turns a personal, built-in or automation skill on or off in Droid's
 * user-level settings. A project skill is refused: Droid writes project-level
 * settings into its working directory, and this session runs in the server's,
 * so the choice would land there and leave the project's skill unchanged
 * (verified against Droid 0.213.0 and 0.230.0).
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
  makeClient: DroidSkillInventoryClientFactory = liveDroidSkillInventoryClient,
) {
  if (input.scope === "project") {
    return yield* new DroidSkillDiscoveryError({
      detail: `Droid project skills are managed in the project. Change '${input.name}' there.`,
    });
  }
  const client = yield* Effect.tryPromise({
    try: (signal) => makeClient({ ...input, signal }),
    catch: (cause) =>
      new DroidSkillDiscoveryError({
        cause,
        detail: "Failed to start Droid's native skill management session.",
      }),
  });

  return yield* Effect.acquireUseRelease(
    Effect.succeed(client),
    (acquired) =>
      Effect.tryPromise({
        try: () => {
          if (!acquired.setSkillDisabled) {
            throw new Error("Droid skill management is unavailable.");
          }
          return acquired.setSkillDisabled(input.name, !input.enabled);
        },
        catch: (cause) =>
          new DroidSkillDiscoveryError({
            cause,
            detail: `Droid failed to ${input.enabled ? "enable" : "disable"} '${input.name}'.`,
          }),
      }).pipe(Effect.as({ effectiveEnabled: input.enabled })),
    (acquired) =>
      Effect.promise(() => acquired.close()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to close Droid's native skill management session.", { cause }),
        ),
      ),
  );
});
