// @effect-diagnostics nodeBuiltinImport:off -- This service owns its app-private policy file.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  readProjectSkillLock,
  type SkillInvocationPolicy,
  type SkillReleaseRef,
} from "@scientfactory/scient-skills";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";

const MAX_POLICY_BYTES = 1024 * 1024;
const SkillReleaseRefSchema = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  version: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  digest: Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))),
  origin: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
const ProjectTrustReceiptSchema = Schema.Struct({
  projectId: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  rootPath: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  lockDigest: Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))),
});
const UserSkillActivationSchema = Schema.Struct({
  release: SkillReleaseRefSchema,
  invocationPolicy: Schema.Literals(["automatic", "explicit"]),
});
const PersistedPolicyV1Schema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  userSkills: Schema.Array(SkillReleaseRefSchema).pipe(Schema.check(Schema.isMaxLength(500))),
  trustedProjects: Schema.Array(ProjectTrustReceiptSchema).pipe(
    Schema.check(Schema.isMaxLength(500)),
  ),
});
const PersistedPolicyV2Schema = Schema.Struct({
  formatVersion: Schema.Literal(2),
  userSkills: Schema.Array(UserSkillActivationSchema).pipe(Schema.check(Schema.isMaxLength(500))),
  trustedProjects: Schema.Array(ProjectTrustReceiptSchema).pipe(
    Schema.check(Schema.isMaxLength(500)),
  ),
});
const PersistedPolicySchema = Schema.Union([PersistedPolicyV1Schema, PersistedPolicyV2Schema]);
const PersistedPolicyJson = Schema.fromJsonString(PersistedPolicySchema);
const decodePersistedPolicy = Schema.decodeUnknownExit(PersistedPolicyJson);
const PersistedPolicyV2Json = Schema.fromJsonString(PersistedPolicyV2Schema);
const encodePersistedPolicy = Schema.encodeEffect(PersistedPolicyV2Json);

export interface ProjectSkillTrustReceipt {
  readonly projectId: string;
  readonly rootPath: string;
  readonly lockDigest: string;
}

export interface UserSkillActivation {
  readonly release: SkillReleaseRef;
  readonly invocationPolicy: SkillInvocationPolicy;
}

export interface ScientSkillPolicySnapshot {
  readonly userSkills: ReadonlyArray<UserSkillActivation>;
  readonly trustedProjects: ReadonlyArray<ProjectSkillTrustReceipt>;
}

export class ScientSkillPolicyError extends Schema.TaggedErrorClass<ScientSkillPolicyError>()(
  "ScientSkillPolicyError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ScientSkillPolicyShape {
  readonly snapshot: Effect.Effect<ScientSkillPolicySnapshot>;
  readonly setUserSkillActivation: (
    release: SkillReleaseRef,
    active: boolean,
    invocationPolicy: SkillInvocationPolicy,
  ) => Effect.Effect<void, ScientSkillPolicyError>;
  readonly trustProjectLock: (
    projectRoot: string,
  ) => Effect.Effect<ProjectSkillTrustReceipt, ScientSkillPolicyError>;
  readonly revokeProjectTrust: (projectRoot: string) => Effect.Effect<void, ScientSkillPolicyError>;
}

const EMPTY_POLICY: ScientSkillPolicySnapshot = Object.freeze({
  userSkills: Object.freeze([]),
  trustedProjects: Object.freeze([]),
});

const emptyService = makeSnapshotService(EMPTY_POLICY);

/** Empty by default; policy becomes live only in the Scient server composition. */
export class ScientSkillPolicy extends Context.Reference<ScientSkillPolicyShape>(
  "t3/scient/skills/ScientSkillPolicy",
  { defaultValue: () => emptyService },
) {}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function releaseIdentity(release: SkillReleaseRef): string {
  return `${release.id}@${release.version}`;
}

function normalizeSnapshot(snapshot: ScientSkillPolicySnapshot): ScientSkillPolicySnapshot {
  const userSkills = new Map<string, UserSkillActivation>();
  for (const activation of snapshot.userSkills) {
    userSkills.set(releaseIdentity(activation.release), activation);
  }
  const trustedProjects = new Map<string, ProjectSkillTrustReceipt>();
  for (const trust of snapshot.trustedProjects) trustedProjects.set(trust.rootPath, trust);
  return Object.freeze({
    userSkills: Object.freeze(
      [...userSkills.values()]
        .sort((a, b) => releaseIdentity(a.release).localeCompare(releaseIdentity(b.release)))
        .map((activation) =>
          Object.freeze({
            ...activation,
            release: Object.freeze({ ...activation.release }),
          }),
        ),
    ),
    trustedProjects: Object.freeze(
      [...trustedProjects.values()]
        .sort((a, b) => a.rootPath.localeCompare(b.rootPath))
        .map((trust) => Object.freeze({ ...trust })),
    ),
  });
}

function makeSnapshotService(snapshot: ScientSkillPolicySnapshot): ScientSkillPolicyShape {
  return {
    snapshot: Effect.succeed(normalizeSnapshot(snapshot)),
    setUserSkillActivation: () => Effect.void,
    trustProjectLock: (projectRoot) =>
      Effect.fail(
        new ScientSkillPolicyError({
          operation: "trustProjectLock",
          message: `Scient skill policy persistence is unavailable for '${projectRoot}'.`,
        }),
      ),
    revokeProjectTrust: () => Effect.void,
  };
}

export const layerFromSnapshot = (snapshot: ScientSkillPolicySnapshot) =>
  Layer.succeed(ScientSkillPolicy, makeSnapshotService(snapshot));

const make = Effect.fn("ScientSkillPolicy.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const policyPath = NodePath.join(config.stateDir, "scient-skills.json");

  const load = Effect.tryPromise({
    try: async (): Promise<ScientSkillPolicySnapshot> => {
      let stat;
      try {
        stat = await NodeFSP.lstat(policyPath);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return EMPTY_POLICY;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_POLICY_BYTES) {
        throw new Error("Scient skill policy must be a regular file no larger than 1 MiB.");
      }
      const decoded = decodePersistedPolicy(await NodeFSP.readFile(policyPath, "utf8"));
      if (Exit.isFailure(decoded)) throw new Error("Scient skill policy is invalid.");
      const value = decoded.value;
      return normalizeSnapshot({
        userSkills:
          value.formatVersion === 1
            ? value.userSkills.map((release) => ({
                release,
                // The dormant v1 foundation had no product UI. If a hand-edited
                // file exists, migrate it to the safer user-only invocation mode.
                invocationPolicy: "explicit" as const,
              }))
            : value.userSkills,
        trustedProjects: value.trustedProjects,
      });
    },
    catch: (cause) =>
      new ScientSkillPolicyError({
        operation: "load",
        message: "Scient skill policy could not be loaded.",
        cause,
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(error.message, { cause: error.cause }).pipe(Effect.as(EMPTY_POLICY)),
    ),
  );

  const state = yield* Ref.make(yield* load);
  const writePermit = yield* Semaphore.make(1);

  const persist = Effect.fn("ScientSkillPolicy.persist")(function* (
    next: ScientSkillPolicySnapshot,
  ) {
    const normalized = normalizeSnapshot(next);
    const encoded = yield* encodePersistedPolicy({
      formatVersion: 2,
      userSkills: [...normalized.userSkills],
      trustedProjects: [...normalized.trustedProjects],
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ScientSkillPolicyError({
            operation: "persist",
            message: "Scient skill policy could not be encoded.",
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.dirname(policyPath), { recursive: true });
        const temporaryPath = `${policyPath}.${NodeCrypto.randomUUID()}.tmp`;
        try {
          await NodeFSP.writeFile(temporaryPath, encoded, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          await NodeFSP.rename(temporaryPath, policyPath);
        } finally {
          await NodeFSP.rm(temporaryPath, { force: true });
        }
      },
      catch: (cause) =>
        new ScientSkillPolicyError({
          operation: "persist",
          message: "Scient skill policy could not be saved.",
          cause,
        }),
    });
    yield* Ref.set(state, normalized);
  });

  const update = (transform: (current: ScientSkillPolicySnapshot) => ScientSkillPolicySnapshot) =>
    writePermit.withPermits(1)(Ref.get(state).pipe(Effect.map(transform), Effect.flatMap(persist)));

  const inspectProjectLock = (projectRoot: string) =>
    Effect.tryPromise({
      try: () => readProjectSkillLock(projectRoot),
      catch: (cause) =>
        new ScientSkillPolicyError({
          operation: "trustProjectLock",
          message: "The project skill lock could not be inspected.",
          cause,
        }),
    });

  return ScientSkillPolicy.of({
    snapshot: Ref.get(state),
    setUserSkillActivation: (release, active, invocationPolicy) =>
      update((current) => ({
        ...current,
        userSkills: active
          ? [
              ...current.userSkills.filter(
                (entry) => releaseIdentity(entry.release) !== releaseIdentity(release),
              ),
              { release, invocationPolicy },
            ]
          : current.userSkills.filter(
              (entry) => releaseIdentity(entry.release) !== releaseIdentity(release),
            ),
      })),
    trustProjectLock: Effect.fn("ScientSkillPolicy.trustProjectLock")(function* (projectRoot) {
      const lock = yield* inspectProjectLock(projectRoot);
      if (lock.status !== "valid") {
        return yield* new ScientSkillPolicyError({
          operation: "trustProjectLock",
          message:
            lock.status === "absent"
              ? "This project has no skill activation lock to trust."
              : lock.message,
        });
      }
      const receipt: ProjectSkillTrustReceipt = {
        projectId: lock.projectId,
        rootPath: lock.rootPath,
        lockDigest: lock.lockDigest,
      };
      yield* update((current) => ({
        ...current,
        trustedProjects: [
          ...current.trustedProjects.filter((entry) => entry.rootPath !== receipt.rootPath),
          receipt,
        ],
      }));
      return receipt;
    }),
    revokeProjectTrust: Effect.fn("ScientSkillPolicy.revokeProjectTrust")(function* (projectRoot) {
      const rootPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(NodePath.resolve(projectRoot)),
        catch: (cause) =>
          new ScientSkillPolicyError({
            operation: "revokeProjectTrust",
            message: "The project root could not be resolved.",
            cause,
          }),
      });
      yield* update((current) => ({
        ...current,
        trustedProjects: current.trustedProjects.filter((entry) => entry.rootPath !== rootPath),
      }));
    }),
  });
});

export const layer = Layer.effect(ScientSkillPolicy, make());
