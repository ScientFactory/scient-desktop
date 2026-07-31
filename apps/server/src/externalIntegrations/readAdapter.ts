/** Governed, transport-dark read adapter for explicitly paired integrations. */
import { ProjectId } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type {
  ScientOperationExecutionOutcome,
  ScientOperationExecutorShape,
} from "../scientOperations/Services/ScientOperationExecutor.ts";
import type { ScientOperationId } from "../scientOperations/authority.ts";
import {
  ExternalIntegrationControlError,
  externalIntegrationThreadHash,
  type ExternalIntegrationControlPlane,
  type ExternalIntegrationReadAdmission,
} from "./controlPlane.ts";
import type { ExternalIntegrationThreadReadQueryShape } from "./threadReadQuery.ts";

export type LocalPeerProof =
  | {
      readonly platform: "darwin" | "linux";
      readonly kind: "unix-peer-credentials";
      readonly uid: number;
      readonly socketOwnerUid: number;
    }
  | {
      readonly platform: "win32";
      readonly kind: "windows-named-pipe-acl";
      readonly clientSid: string;
      readonly aclOwnerSid: string;
      readonly rejectsRemoteClients: boolean;
    };

/**
 * Convert OS-derived peer facts to a stable binding. Windows deliberately has
 * no fallback: a named-pipe caller without matching SID, owner ACL and remote
 * rejection is denied before any integration lookup.
 */
export function verifyLocalPeerProof(proof: LocalPeerProof): string {
  if (proof.platform === "win32") {
    if (
      proof.kind !== "windows-named-pipe-acl" ||
      !proof.rejectsRemoteClients ||
      proof.clientSid.trim().length === 0 ||
      proof.clientSid !== proof.aclOwnerSid
    ) {
      throw new ExternalIntegrationControlError({
        code: "peer_identity_mismatch",
        message: "Windows local peer and named-pipe ACL identity could not be proven.",
      });
    }
    return `windows-sid:${proof.clientSid}`;
  }
  if (
    proof.kind !== "unix-peer-credentials" ||
    !Number.isSafeInteger(proof.uid) ||
    proof.uid < 0 ||
    proof.uid !== proof.socketOwnerUid
  ) {
    throw new ExternalIntegrationControlError({
      code: "peer_identity_mismatch",
      message: "Unix local peer identity could not be proven.",
    });
  }
  return `unix-uid:${proof.uid}`;
}

export type ExternalIntegrationReadRequest =
  | { readonly operation: "project.context.read" }
  | { readonly operation: "project.list" }
  | {
      readonly operation: "thread.list";
      readonly includeArchived?: boolean;
      readonly limit?: number;
    }
  | {
      readonly operation: "thread.read";
      readonly threadId: string;
      readonly cursor?: string;
      readonly messageLimit?: number;
      readonly maxMessageChars?: number;
    };

export interface ExternalIntegrationReadCall {
  readonly externalIdentity: string;
  readonly credentialReference: string;
  readonly accessToken: string;
  readonly peerProof: LocalPeerProof;
  readonly projectId: string;
  readonly request: ExternalIntegrationReadRequest;
}

export type ExternalIntegrationReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };
export type ExternalIntegrationReadAdapterError =
  | ExternalIntegrationControlError
  | PersistenceSqlError;

export interface ExternalIntegrationReadBackend {
  readonly project: (projectId: string) => Effect.Effect<unknown, unknown>;
  readonly listThreads: (input: {
    readonly projectId: string;
    readonly scopedThreadHashes: ReadonlyArray<string>;
    readonly includeArchived: boolean;
    readonly limit: number;
  }) => Effect.Effect<unknown, unknown>;
  readonly readThread: (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly cursor?: string;
    readonly messageLimit?: number;
    readonly maxMessageChars?: number;
  }) => Effect.Effect<unknown, unknown>;
}

export interface ExternalIntegrationReadAdapter {
  readonly execute: (
    input: ExternalIntegrationReadCall,
  ) => Effect.Effect<
    ScientOperationExecutionOutcome<
      ExternalIntegrationReadResult,
      ExternalIntegrationReadAdapterError
    >,
    ExternalIntegrationReadAdapterError | unknown
  >;
}

function boundedPage(value: number | undefined, fallback: number, max: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(1, Math.min(Math.trunc(value), max));
}

function canonicalInput(
  request: ExternalIntegrationReadRequest,
): Readonly<Record<string, unknown>> {
  switch (request.operation) {
    case "project.context.read":
    case "project.list":
      return {};
    case "thread.list":
      return {
        includeArchived: request.includeArchived ?? false,
        limit: boundedPage(request.limit, 50, 200),
      };
    case "thread.read":
      return {
        threadId: request.threadId,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.messageLimit === undefined ? {} : { messageLimit: request.messageLimit }),
        ...(request.maxMessageChars === undefined
          ? {}
          : { maxMessageChars: request.maxMessageChars }),
      };
  }
}

function readBackendEffect(
  backend: ExternalIntegrationReadBackend,
  input: ExternalIntegrationReadCall,
  admission: ExternalIntegrationReadAdmission,
  canonical: Readonly<Record<string, unknown>>,
): Effect.Effect<ExternalIntegrationReadResult> {
  const operation = input.request.operation;
  const effect =
    operation === "project.context.read"
      ? Effect.succeed({
          integrationId: admission.integrationHash,
          projectId: input.projectId,
          capabilities: admission.authority.capabilities,
          transport: "production-dark",
        })
      : operation === "project.list"
        ? backend.project(input.projectId)
        : operation === "thread.list"
          ? backend.listThreads({
              projectId: input.projectId,
              scopedThreadHashes: admission.scopedThreadHashes,
              includeArchived: canonical.includeArchived === true,
              limit: canonical.limit as number,
            })
          : backend.readThread({
              projectId: input.projectId,
              threadId: canonical.threadId as string,
              ...(typeof canonical.cursor === "string" ? { cursor: canonical.cursor } : {}),
              ...(typeof canonical.messageLimit === "number"
                ? { messageLimit: canonical.messageLimit }
                : {}),
              ...(typeof canonical.maxMessageChars === "number"
                ? { maxMessageChars: canonical.maxMessageChars }
                : {}),
            });
  return effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch(() =>
      Effect.succeed({
        ok: false as const,
        code: "read_backend_failed",
        message: "The governed Scient read could not be completed.",
      }),
    ),
  );
}

export function makeExternalIntegrationReadAdapter(input: {
  readonly controlPlane: ExternalIntegrationControlPlane;
  readonly operationExecutor: ScientOperationExecutorShape;
  readonly backend: ExternalIntegrationReadBackend;
}): ExternalIntegrationReadAdapter {
  return {
    execute: (call) =>
      Effect.gen(function* () {
        const verifiedPeerIdentity = yield* Effect.try({
          try: () => verifyLocalPeerProof(call.peerProof),
          catch: (cause) =>
            cause instanceof ExternalIntegrationControlError
              ? cause
              : new ExternalIntegrationControlError({
                  code: "peer_identity_mismatch",
                  message: "Local peer identity could not be proven.",
                }),
        });
        const admission = yield* input.controlPlane.admitRead({
          externalIdentity: call.externalIdentity,
          credentialReference: call.credentialReference,
          accessToken: call.accessToken,
          verifiedPeerIdentity,
          operation: call.request.operation,
          projectId: call.projectId,
          ...(call.request.operation === "thread.read" ? { threadId: call.request.threadId } : {}),
        });
        const domainInput = canonicalInput(call.request);
        return yield* input.operationExecutor.execute<
          ExternalIntegrationReadResult,
          ExternalIntegrationReadAdmission,
          ExternalIntegrationReadAdapterError
        >({
          authority: admission.authority,
          operation: call.request.operation,
          projectId: call.projectId,
          ingress: "external-mcp",
          domainInput,
          admit: Effect.succeed(admission),
          execute: (canonical) => readBackendEffect(input.backend, call, admission, canonical),
          releaseRead: (currentAdmission) => input.controlPlane.releaseRead(currentAdmission),
          releaseReplay: (currentAdmission) => input.controlPlane.releaseRead(currentAdmission),
          runTransactionalWrite: () =>
            Effect.die("External integration adapter cannot execute writes."),
          // No transport is live yet. Release revalidation is the fail-closed
          // revocation boundary; a future scoped transport may add eager wakeup.
          revocationFence: Effect.never,
          resultErrorCode: (result) => (result.ok ? null : result.code),
        });
      }),
  };
}

/** Projection-backed implementation with paths, attachments and raw diagnostics withheld. */
export function makeProjectionExternalIntegrationReadBackend(
  snapshotQuery: ProjectionSnapshotQueryShape,
  threadReadQuery: ExternalIntegrationThreadReadQueryShape,
): ExternalIntegrationReadBackend {
  return {
    project: (projectId) =>
      snapshotQuery.getProjectShellById(ProjectId.makeUnsafe(projectId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail("project_not_found"),
            onSome: (project) =>
              Effect.succeed({
                projectId: project.id,
                title: project.title,
                kind: project.kind,
                isPinned: project.isPinned,
              }),
          }),
        ),
      ),
    listThreads: ({ projectId, scopedThreadHashes, includeArchived, limit }) =>
      snapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) => ({
          threads: snapshot.threads
            .filter((thread) => thread.projectId === projectId)
            .filter((thread) =>
              scopedThreadHashes.includes(externalIntegrationThreadHash(thread.id)),
            )
            .filter((thread) => includeArchived || (thread.archivedAt ?? null) === null)
            .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
            .slice(0, limit)
            .map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              status: thread.latestTurn?.state ?? thread.session?.status ?? "idle",
              parentThreadId:
                thread.parentThreadId !== undefined &&
                thread.parentThreadId !== null &&
                scopedThreadHashes.includes(externalIntegrationThreadHash(thread.parentThreadId))
                  ? thread.parentThreadId
                  : null,
              archived: (thread.archivedAt ?? null) !== null,
              updatedAt: thread.updatedAt,
            })),
        })),
      ),
    readThread: ({ projectId, threadId, cursor, messageLimit, maxMessageChars }) =>
      threadReadQuery
        .readPage({
          projectId,
          threadId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(messageLimit === undefined ? {} : { messageLimit }),
        })
        .pipe(
          Effect.map((thread) => {
            const chars = boundedPage(maxMessageChars, 1500, 20_000);
            return {
              threadId: thread.threadId,
              projectId: thread.projectId,
              title: thread.title,
              status: thread.status,
              archived: thread.archived,
              messages: thread.messages.map((message) => ({
                index: message.index,
                role: message.role,
                text: message.text.slice(0, chars),
                truncated: message.text.length > chars,
                createdAt: message.createdAt,
              })),
              totalMessages: thread.totalMessages,
              nextCursor: thread.nextCursor,
            };
          }),
        ),
  };
}

export type ExternalIntegrationReadOperation = Extract<
  ScientOperationId,
  ExternalIntegrationReadRequest["operation"]
>;
