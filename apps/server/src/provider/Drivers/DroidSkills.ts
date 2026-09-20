import type { ServerProviderSkill } from "@t3tools/contracts";
import { DroidClient, ProcessTransport } from "@factory/droid-sdk/node";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const DroidSkillLocation = Schema.Literals(["project", "personal", "builtin", "automation"]);
const DroidSkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: DroidSkillLocation,
  filePath: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  userInvocable: Schema.optional(Schema.Boolean),
});
const DroidSkillInventory = Schema.Struct({
  skills: Schema.Array(DroidSkillInfo),
  projectAvailable: Schema.optional(Schema.Boolean),
});
const decodeDroidSkillInventory = Schema.decodeUnknownEffect(DroidSkillInventory);

const DROID_SKILL_DISCOVERY_ERROR_TAG = "DroidSkillDiscoveryError";
export class DroidSkillDiscoveryError extends Data.TaggedError(DROID_SKILL_DISCOVERY_ERROR_TAG)<{
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = Predicate.isTagged(DROID_SKILL_DISCOVERY_ERROR_TAG);
}

export interface DroidSkillInventoryClient {
  readonly close: () => Promise<void>;
  readonly listSkills: () => Promise<unknown>;
}

export type DroidSkillInventoryClientFactory = (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}) => Promise<DroidSkillInventoryClient>;

// Deliberately use the official SDK's transport and protocol client instead of
// its high-level createSession helper. The helper requires FACTORY_API_KEY,
// while Scient also supports Droid's existing subscription login. The lower
// level client preserves that login and still owns framing, request matching,
// protocol compatibility, process cleanup, and cross-platform spawning.
const liveDroidSkillInventoryClient: DroidSkillInventoryClientFactory = async (input) => {
  const environment = Object.fromEntries(
    Object.entries(input.environment).flatMap(([key, value]) =>
      value === undefined ? [] : ([[key, value]] as const),
    ),
  );
  const transport = new ProcessTransport({
    droidExecPath: input.binaryPath,
    cwd: input.cwd,
    env: environment,
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
    client = new DroidClient({ transport });
    const initialized = await client.initializeSession({
      machineId: "scient-provider-skill-inventory",
      cwd: input.cwd,
    });
    if (initialized.error) {
      throw new Error(initialized.error.message);
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
    skills.push({
      name,
      path,
      scope: skill.location,
      enabled: skill.enabled !== false,
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
