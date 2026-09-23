// @effect-diagnostics nodeBuiltinImport:off -- Resume containment is a pure lexical path check, shared with tests, and must not depend on the Effect Path service.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OMP_SESSION_CURSOR_VERSION = 1;

export const OmpSessionCursor = Schema.Struct({
  schemaVersion: Schema.Literal(OMP_SESSION_CURSOR_VERSION),
  providerInstanceId: Schema.String,
  sessionId: Schema.optional(Schema.String),
  relativeSessionFile: Schema.String,
  ompVersion: Schema.optional(Schema.String),
  rpcProtocolVersion: Schema.Finite,
  stateScopeFingerprint: Schema.String,
  binaryPathFingerprint: Schema.optional(Schema.String),
  /**
   * Last Oh My Pi prompt id. Recorded so a later reconciliation can name the
   * request. Scient does not use it to skip a retried prompt.
   */
  lastRequestId: Schema.optional(Schema.String),
});
export type OmpSessionCursor = typeof OmpSessionCursor.Type;

const decodeCursor = Schema.decodeUnknownEffect(OmpSessionCursor);

export const ompStateScopeFingerprint = (providerInstanceId: string, sessionRoot: string): string =>
  NodeCrypto.createHash("sha256")
    .update(`${providerInstanceId}\0${NodePath.resolve(sessionRoot)}`)
    .digest("hex");

/** Directory key for a thread. Thread ids are not path-safe, so they never enter the path. */
export const ompSessionDirectoryKey = (instanceId: string, threadId: string): string =>
  NodeCrypto.createHash("sha256").update(`${instanceId}\0${threadId}`).digest("hex").slice(0, 32);

export const ompBinaryFingerprint = (binaryPath: string): string =>
  NodeCrypto.createHash("sha256").update(binaryPath).digest("hex");

/**
 * Resume across patch versions of the same major. A different major is refused
 * because session files are not a stable cross-major contract. Home, theme, and
 * profile changes are intentionally not part of this identity.
 */
export const ompMajorCompatible = (stored: string | undefined, running: string): boolean => {
  if (!stored) return true;
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
    readonly providerInstanceId: string;
    readonly sessionRoot: string;
    readonly expectedBinaryFingerprint?: string;
  },
): Effect.Effect<OmpSessionCursor, string> =>
  decodeCursor(value).pipe(
    Effect.mapError(() => "Oh My Pi resume cursor is not a recognized session record."),
    Effect.flatMap((cursor) => {
      if (cursor.providerInstanceId !== input.providerInstanceId) {
        return Effect.fail("Oh My Pi resume cursor belongs to a different provider instance.");
      }
      if (
        cursor.binaryPathFingerprint &&
        input.expectedBinaryFingerprint &&
        cursor.binaryPathFingerprint !== input.expectedBinaryFingerprint
      ) {
        return Effect.fail("Oh My Pi resume cursor was written by a different executable.");
      }
      if (
        cursor.stateScopeFingerprint !==
        ompStateScopeFingerprint(input.providerInstanceId, input.sessionRoot)
      ) {
        return Effect.fail("Oh My Pi resume cursor does not match this session directory.");
      }
      if (!sessionFileInsideRoot(input.sessionRoot, cursor.relativeSessionFile)) {
        return Effect.fail("Oh My Pi resume cursor points outside its session directory.");
      }
      return Effect.succeed(cursor);
    }),
  );

export const makeOmpSessionCursor = (input: {
  readonly providerInstanceId: string;
  readonly sessionRoot: string;
  readonly sessionFile: string;
  readonly sessionId?: string;
  readonly ompVersion?: string;
  readonly rpcProtocolVersion: number;
  readonly binaryPathFingerprint?: string;
  readonly lastRequestId?: string;
}): OmpSessionCursor | undefined => {
  const relativeSessionFile = sessionFileInsideRoot(input.sessionRoot, input.sessionFile);
  if (!relativeSessionFile) return undefined;
  return {
    schemaVersion: OMP_SESSION_CURSOR_VERSION,
    providerInstanceId: input.providerInstanceId,
    relativeSessionFile,
    rpcProtocolVersion: input.rpcProtocolVersion,
    stateScopeFingerprint: ompStateScopeFingerprint(input.providerInstanceId, input.sessionRoot),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.ompVersion ? { ompVersion: input.ompVersion } : {}),
    ...(input.binaryPathFingerprint ? { binaryPathFingerprint: input.binaryPathFingerprint } : {}),
    ...(input.lastRequestId ? { lastRequestId: input.lastRequestId } : {}),
  };
};
