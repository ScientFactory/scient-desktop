// @effect-diagnostics nodeBuiltinImport:off -- Resume containment is a pure lexical path check, shared with tests, and must not depend on the Effect Path service.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OMP_SESSION_CURSOR_VERSION = 3;
const OMP_LEGACY_SESSION_CURSOR_VERSION = 2;
const OMP_LAUNCH_POLICY = "rpc-v2;approval-mode=yolo;session-dir=explicit" as const;

// v2 is decoded only to produce a precise fail-closed migration error. Its
// executable hash included PATH, so it cannot be safely compared to v3.
export const OmpSessionCursor = Schema.Struct({
  schemaVersion: Schema.Literals([OMP_LEGACY_SESSION_CURSOR_VERSION, OMP_SESSION_CURSOR_VERSION]),
  providerInstanceId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  relativeSessionFile: Schema.String,
  ompVersion: Schema.String,
  rpcProtocolVersion: Schema.Finite,
  stateScopeFingerprint: Schema.String,
  binaryPathFingerprint: Schema.String,
  workspaceFingerprint: Schema.String,
  homeProfileFingerprint: Schema.String,
  launchPolicyFingerprint: Schema.String,
  /**
   * Last Oh My Pi prompt id. Recorded so a later reconciliation can name the
   * request. Scient does not use it to skip a retried prompt.
   */
  lastRequestId: Schema.optional(Schema.String),
});
export type OmpSessionCursor = typeof OmpSessionCursor.Type;

const decodeCursor = Schema.decodeUnknownEffect(OmpSessionCursor);

const fingerprint = (parts: ReadonlyArray<string>): string =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex");

export interface OmpResumeIdentity {
  readonly providerInstanceId: string;
  readonly sessionRoot: string;
  readonly workspace: string;
  readonly binaryPathFingerprint: string;
  readonly homeIdentity: string;
  readonly profileIdentity: string;
}

export const ompStateScopeFingerprint = (input: OmpResumeIdentity): string =>
  fingerprint([
    input.providerInstanceId,
    NodePath.resolve(input.sessionRoot),
    NodePath.resolve(input.workspace),
    input.binaryPathFingerprint,
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

/**
 * A Scient-managed binary lives under `versions/<release>/`. Resume identity
 * keeps the managed family and drops that release directory, so a qualified
 * update can reopen the same session. A custom or system binary stays exact.
 */
export const ompBinaryFingerprint = (binaryPath: string): string => {
  const resolved = NodePath.resolve(binaryPath).replaceAll("\\", "/");
  const managed = resolved.replace(
    /\/provider-runtimes\/omp\/versions\/[^/]+\//u,
    "/provider-runtimes/omp/versions/current/",
  );
  return fingerprint(["binary", managed]);
};

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

export const parseOmpSessionCursor = (
  value: unknown,
  input: {
    readonly identity: OmpResumeIdentity;
    readonly ompVersion?: string;
    readonly rpcProtocolVersion: number;
    /** The adapter resolves the executable immediately before parsing the cursor. */
    readonly deferBinaryIdentity?: boolean;
  },
): Effect.Effect<OmpSessionCursor, string> =>
  decodeCursor(value).pipe(
    Effect.mapError(() => "Oh My Pi resume cursor is not a recognized session record."),
    Effect.flatMap((cursor) => {
      if (cursor.providerInstanceId !== input.identity.providerInstanceId) {
        return Effect.fail("Oh My Pi resume cursor belongs to a different provider instance.");
      }
      if (cursor.workspaceFingerprint !== ompWorkspaceFingerprint(input.identity.workspace)) {
        return Effect.fail("Oh My Pi resume cursor belongs to a different workspace.");
      }
      if (
        cursor.homeProfileFingerprint !==
        ompHomeProfileFingerprint(input.identity.homeIdentity, input.identity.profileIdentity)
      ) {
        return Effect.fail("Oh My Pi resume cursor belongs to a different home or profile.");
      }
      if (cursor.launchPolicyFingerprint !== ompLaunchPolicyFingerprint()) {
        return Effect.fail("Oh My Pi resume cursor was written with a different launch policy.");
      }
      if (cursor.rpcProtocolVersion !== input.rpcProtocolVersion) {
        return Effect.fail("Oh My Pi resume cursor uses an incompatible RPC protocol.");
      }
      if (input.ompVersion && !ompMajorCompatible(cursor.ompVersion, input.ompVersion)) {
        return Effect.fail("Oh My Pi resume cursor was written by a different major version.");
      }
      if (!sessionFileInsideRoot(input.identity.sessionRoot, cursor.relativeSessionFile)) {
        return Effect.fail("Oh My Pi resume cursor points outside its session directory.");
      }
      if (cursor.schemaVersion === OMP_LEGACY_SESSION_CURSOR_VERSION) {
        return Effect.fail(
          "This Oh My Pi session cursor uses an older identity format and cannot be safely migrated. Start a new session.",
        );
      }
      if (
        !input.deferBinaryIdentity &&
        cursor.binaryPathFingerprint !== input.identity.binaryPathFingerprint
      ) {
        return Effect.fail("Oh My Pi resume cursor was written by a different executable.");
      }
      if (
        !input.deferBinaryIdentity &&
        cursor.stateScopeFingerprint !== ompStateScopeFingerprint(input.identity)
      ) {
        return Effect.fail("Oh My Pi resume cursor does not match this session scope.");
      }
      return Effect.succeed(cursor);
    }),
  );

export const makeOmpSessionCursor = (input: {
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
    ompVersion: input.ompVersion,
    rpcProtocolVersion: input.rpcProtocolVersion,
    stateScopeFingerprint: ompStateScopeFingerprint(input.identity),
    binaryPathFingerprint: input.identity.binaryPathFingerprint,
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
