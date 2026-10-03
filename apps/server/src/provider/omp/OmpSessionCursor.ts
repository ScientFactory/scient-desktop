// @effect-diagnostics nodeBuiltinImport:off -- Resume containment is a pure lexical path check, shared with tests, and must not depend on the Effect Path service.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ompTarget, type OmpTarget } from "./OmpTarget.ts";

const OMP_SESSION_CURSOR_VERSION = 4;
const OMP_V3_SESSION_CURSOR_VERSION = 3;
const OMP_V2_SESSION_CURSOR_VERSION = 2;
const OMP_LAUNCH_POLICY = "rpc-v2;approval-mode=yolo;session-dir=explicit" as const;

const cursorFields = {
  providerInstanceId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  relativeSessionFile: Schema.String,
  /**
   * The product that wrote the cursor. Absent on an Oh My Pi cursor: those
   * predate a second product and keep their recorded shape.
   */
  driverKind: Schema.optional(Schema.String),
  ompVersion: Schema.String,
  rpcProtocolVersion: Schema.Finite,
  stateScopeFingerprint: Schema.String,
  workspaceFingerprint: Schema.String,
  homeProfileFingerprint: Schema.String,
  launchPolicyFingerprint: Schema.String,
  /**
   * Last Oh My Pi prompt id. Recorded so a later reconciliation can name the
   * request. Scient does not use it to skip a retried prompt.
   */
  lastRequestId: Schema.optional(Schema.String),
};

/**
 * Resume identity is the provider instance, the OMP home/profile, the
 * workspace, the RPC protocol, and OMP major compatibility. The executable is
 * not part of it: the transcript lives in Scient's own per-conversation
 * `--session-dir`, so a switch between system and Scient-managed OMP, or a
 * package-manager upgrade that moves the binary, resumes the same session.
 */
export const OmpSessionCursor = Schema.Struct({
  schemaVersion: Schema.Literal(OMP_SESSION_CURSOR_VERSION),
  ...cursorFields,
});
export type OmpSessionCursor = typeof OmpSessionCursor.Type;

/**
 * v3 also recorded an executable fingerprint and folded it into its scope
 * fingerprint. It migrates when that scope, recomputed with its own recorded
 * executable, still matches this instance, session directory, workspace,
 * home and profile. v2 hashed PATH into the executable identity, so it cannot
 * be verified and is refused.
 */
const LegacyOmpSessionCursor = Schema.Struct({
  schemaVersion: Schema.Literals([OMP_V2_SESSION_CURSOR_VERSION, OMP_V3_SESSION_CURSOR_VERSION]),
  ...cursorFields,
  binaryPathFingerprint: Schema.String,
});

const decodeCursor = Schema.decodeUnknownEffect(
  Schema.Union([OmpSessionCursor, LegacyOmpSessionCursor]),
);

const legacyCursorMessage = (target: OmpTarget) =>
  `This ${target.name} session cursor uses an older identity format and cannot be safely migrated. Start a new session.`;

const fingerprint = (parts: ReadonlyArray<string>): string =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex");

export interface OmpResumeIdentity {
  readonly providerInstanceId: string;
  readonly sessionRoot: string;
  readonly workspace: string;
  readonly homeIdentity: string;
  readonly profileIdentity: string;
}

export const ompStateScopeFingerprint = (input: OmpResumeIdentity): string =>
  fingerprint([
    "scope-v4",
    input.providerInstanceId,
    NodePath.resolve(input.sessionRoot),
    NodePath.resolve(input.workspace),
    input.homeIdentity,
    input.profileIdentity,
    OMP_LAUNCH_POLICY,
  ]);

/** The v3 scope, which also bound the recorded executable fingerprint. */
const ompV3StateScopeFingerprint = (
  input: OmpResumeIdentity,
  binaryPathFingerprint: string,
): string =>
  fingerprint([
    input.providerInstanceId,
    NodePath.resolve(input.sessionRoot),
    NodePath.resolve(input.workspace),
    binaryPathFingerprint,
    input.homeIdentity,
    input.profileIdentity,
    OMP_LAUNCH_POLICY,
  ]);

export const ompWorkspaceFingerprint = (workspace: string): string =>
  fingerprint(["workspace", NodePath.resolve(workspace)]);

export const ompHomeProfileFingerprint = (homeIdentity: string, profileIdentity: string): string =>
  fingerprint(["home-profile", homeIdentity, profileIdentity]);

export const ompLaunchPolicyFingerprint = (): string =>
  fingerprint(["launch-policy", OMP_LAUNCH_POLICY]);

/** Directory key for a thread. Thread ids are not path-safe, so they never enter the path. */
export const ompSessionDirectoryKey = (instanceId: string, threadId: string): string =>
  NodeCrypto.createHash("sha256").update(`${instanceId}\0${threadId}`).digest("hex").slice(0, 32);

/** Resume across patch versions of the same major. A different major is refused. */
export const ompMajorCompatible = (stored: string, running: string): boolean => {
  const storedMajor = Number.parseInt(stored.split(".")[0] ?? "", 10);
  const runningMajor = Number.parseInt(running.split(".")[0] ?? "", 10);
  return Number.isInteger(storedMajor) && storedMajor > 0 && storedMajor === runningMajor;
};

/** Lexical containment. A path that escapes the session root cannot be resumed. */
export const sessionFileInsideRoot = (
  sessionRoot: string,
  candidate: string,
): string | undefined => {
  const root = NodePath.resolve(sessionRoot);
  const resolved = NodePath.resolve(root, candidate);
  const relative = NodePath.relative(root, resolved);
  if (relative.length === 0 || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(NodePath.sep).join("/");
};

/**
 * Validate a stored cursor against the resuming conversation. The major
 * version check needs the running executable's version, so a caller that
 * parses before launch checks `ompMajorCompatible` once the process reports it.
 * A migrated v3 cursor is returned in the current format.
 */
export const parseOmpSessionCursor = (
  value: unknown,
  input: {
    readonly target: OmpTarget;
    readonly identity: OmpResumeIdentity;
    readonly ompVersion?: string;
    readonly rpcProtocolVersion: number;
  },
): Effect.Effect<OmpSessionCursor, string> =>
  decodeCursor(value).pipe(
    Effect.mapError(() => `${input.target.name} resume cursor is not a recognized session record.`),
    Effect.flatMap((cursor): Effect.Effect<OmpSessionCursor, string> => {
      if (cursor.providerInstanceId !== input.identity.providerInstanceId) {
        return Effect.fail(
          `${input.target.name} resume cursor belongs to a different provider instance.`,
        );
      }
      // The products share a session format, so nothing else in a cursor
      // tells one's transcript from the other's.
      if ((cursor.driverKind ?? ompTarget.driverKind) !== input.target.driverKind) {
        return Effect.fail(`${input.target.name} resume cursor was written by a different agent.`);
      }
      if (cursor.workspaceFingerprint !== ompWorkspaceFingerprint(input.identity.workspace)) {
        return Effect.fail(`${input.target.name} resume cursor belongs to a different workspace.`);
      }
      if (
        cursor.homeProfileFingerprint !==
        ompHomeProfileFingerprint(input.identity.homeIdentity, input.identity.profileIdentity)
      ) {
        return Effect.fail(
          `${input.target.name} resume cursor belongs to a different home or profile.`,
        );
      }
      if (cursor.launchPolicyFingerprint !== ompLaunchPolicyFingerprint()) {
        return Effect.fail(
          `${input.target.name} resume cursor was written with a different launch policy.`,
        );
      }
      if (cursor.rpcProtocolVersion !== input.rpcProtocolVersion) {
        return Effect.fail(`${input.target.name} resume cursor uses an incompatible RPC protocol.`);
      }
      if (input.ompVersion && !ompMajorCompatible(cursor.ompVersion, input.ompVersion)) {
        return Effect.fail(
          `${input.target.name} resume cursor was written by a different major version.`,
        );
      }
      if (!sessionFileInsideRoot(input.identity.sessionRoot, cursor.relativeSessionFile)) {
        return Effect.fail(
          `${input.target.name} resume cursor points outside its session directory.`,
        );
      }
      if (cursor.schemaVersion !== OMP_SESSION_CURSOR_VERSION) {
        if (
          cursor.schemaVersion === OMP_V2_SESSION_CURSOR_VERSION ||
          cursor.stateScopeFingerprint !==
            ompV3StateScopeFingerprint(input.identity, cursor.binaryPathFingerprint)
        ) {
          return Effect.fail(legacyCursorMessage(input.target));
        }
        const { binaryPathFingerprint: _executable, ...fields } = cursor;
        return Effect.succeed({
          ...fields,
          schemaVersion: OMP_SESSION_CURSOR_VERSION,
          stateScopeFingerprint: ompStateScopeFingerprint(input.identity),
        });
      }
      if (cursor.stateScopeFingerprint !== ompStateScopeFingerprint(input.identity)) {
        return Effect.fail(`${input.target.name} resume cursor does not match this session scope.`);
      }
      return Effect.succeed(cursor);
    }),
  );

export const makeOmpSessionCursor = (input: {
  readonly target: OmpTarget;
  readonly identity: OmpResumeIdentity;
  readonly sessionFile: string;
  readonly sessionId?: string;
  readonly ompVersion: string;
  readonly rpcProtocolVersion: number;
  readonly lastRequestId?: string;
}): OmpSessionCursor | undefined => {
  const relativeSessionFile = sessionFileInsideRoot(input.identity.sessionRoot, input.sessionFile);
  if (!relativeSessionFile) return undefined;
  return {
    schemaVersion: OMP_SESSION_CURSOR_VERSION,
    providerInstanceId: input.identity.providerInstanceId,
    relativeSessionFile,
    ...(input.target.driverKind === ompTarget.driverKind
      ? {}
      : { driverKind: input.target.driverKind }),
    ompVersion: input.ompVersion,
    rpcProtocolVersion: input.rpcProtocolVersion,
    stateScopeFingerprint: ompStateScopeFingerprint(input.identity),
    workspaceFingerprint: ompWorkspaceFingerprint(input.identity.workspace),
    homeProfileFingerprint: ompHomeProfileFingerprint(
      input.identity.homeIdentity,
      input.identity.profileIdentity,
    ),
    launchPolicyFingerprint: ompLaunchPolicyFingerprint(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.lastRequestId ? { lastRequestId: input.lastRequestId } : {}),
  };
};
