import type {
  DocumentPersistenceFailureKind,
  DocumentPersistenceOptions,
  DocumentPersistenceReadResult,
  DocumentPersistenceCurrentReview,
} from "@scientfactory/scient-document";
import type {
  MarkdownSaveIntent,
  MarkdownPersistenceSnapshot,
} from "@scientfactory/scient-markdown";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  ProjectDeleteFileError,
  ProjectReadFileError,
  ProjectRenameFileError,
  ProjectWriteFileError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";

import { environmentCatalog } from "~/connection/catalog";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { normalizeMarkdownReadSnapshot } from "./markdownReadSnapshot";
import {
  describeDocumentPublicationAttention,
  documentCurrentMissingReview,
  documentPublicationOutcome,
} from "./documentFailureReason";

export interface MarkdownPersistenceTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export type MarkdownPersistenceFailureKind = DocumentPersistenceFailureKind;

const isReadFailure = Schema.is(ProjectReadFileError);
const isWriteFailure = Schema.is(ProjectWriteFileError);
const isRenameFailure = Schema.is(ProjectRenameFileError);
const isDeleteFailure = Schema.is(ProjectDeleteFileError);
const isConnectionTransient = Schema.is(ConnectionTransientError);
const isRpcFailure = Schema.is(RpcClientError.RpcClientError);

function classifyReason(error: unknown): MarkdownPersistenceFailureKind {
  if (
    isWriteFailure(error) ||
    isReadFailure(error) ||
    isRenameFailure(error) ||
    isDeleteFailure(error)
  ) {
    if (error.failure === "revision_conflict") return "conflict";
    if (
      error.failure === "target_changed" ||
      error.failure === "recovery_required" ||
      error.failure === "mutation_unavailable" ||
      error.failure === "mutation_intent_conflict"
    )
      return error.failure;
    // The server proved nothing was written (a plain save failed before its rename), so
    // trying the same intent again is safe and needs no review.
    if (error.failure === "operation_failed" && error.publicationOutcome === "unchanged")
      return "transient";
    if (error.failure === "operation_failed") return "operation";
    return "terminal";
  }
  if (isConnectionTransient(error)) return "transient";
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentRpcUnavailableError"
  ) {
    return "transient";
  }
  if (isRpcFailure(error)) {
    switch (error.reason._tag) {
      case "SocketReadError":
      case "SocketWriteError":
      case "SocketOpenError":
      case "SocketCloseError":
        return "transient";
      default:
        // Decoding/protocol defects are not evidence that repeating a write is safe.
        return "terminal";
    }
  }
  return "terminal";
}

/** Classify every reason; never let squashing hide a defect behind a retryable failure. */
export function classifyMarkdownPersistenceFailure(error: unknown): MarkdownPersistenceFailureKind {
  if (!Cause.isCause(error)) return classifyReason(error);
  if (error.reasons.length === 0) return "terminal";
  const kinds = error.reasons.map((reason) => {
    if (reason._tag === "Interrupt") return "transient";
    return reason._tag === "Fail" ? classifyReason(reason.error) : "terminal";
  });
  if (kinds.includes("recovery_required")) return "recovery_required";
  if (kinds.includes("mutation_intent_conflict")) return "mutation_intent_conflict";
  if (kinds.includes("target_changed")) return "target_changed";
  if (kinds.includes("mutation_unavailable")) return "mutation_unavailable";
  const first = kinds[0]!;
  return kinds.every((kind) => kind === first) ? first : "terminal";
}

export interface MarkdownPersistenceTransport {
  readonly write: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly read: () => Promise<DocumentPersistenceReadResult>;
  readonly readForReview?: () => Promise<DocumentPersistenceCurrentReview>;
  readonly resolve?: DocumentPersistenceOptions["resolve"];
  readonly describeAttention?: DocumentPersistenceOptions["describeAttention"];
  readonly describeOutcome?: DocumentPersistenceOptions["describeOutcome"];
  readonly classifyFailure: typeof classifyMarkdownPersistenceFailure;
  readonly subscribe: (callbacks: {
    readonly hint: (reason: string) => void;
    readonly connected: (connected: boolean) => void;
  }) => () => void;
  readonly project: (snapshot: MarkdownPersistenceSnapshot) => void;
}

/** The retained coordinator owns these commands; React remounts do not replace their lane. */
export function createMarkdownPersistenceTransport(
  target: MarkdownPersistenceTarget,
): MarkdownPersistenceTransport {
  const input = { cwd: target.cwd, relativePath: target.relativePath };
  const options = { reportFailure: false, reportDefect: false };
  let projectedSource: string | undefined;
  let projectedRevision: string | undefined;
  let confirmedRevision: string | undefined;
  let wasPending = false;
  const transport: MarkdownPersistenceTransport = {
    async write(intent) {
      const result = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.writeFile,
        {
          environmentId: target.environmentId,
          input: {
            ...input,
            contents: intent.source,
            ...(intent.createOnly
              ? { createOnly: true }
              : { expectedRevision: intent.expectedRevision }),
            mutationId: intent.mutationId,
          },
        },
        options,
      );
      if (result._tag === "Failure") throw result.cause;
      return { revision: result.value.revision };
    },
    async read() {
      const result = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.readFileOrdered,
        {
          environmentId: target.environmentId,
          input,
        },
        options,
      );
      if (result._tag === "Failure") throw result.cause;
      const snapshot = normalizeMarkdownReadSnapshot(result.value);
      return {
        source: snapshot.contents,
        revision: snapshot.revision,
        truncated: snapshot.truncated,
        ...(snapshot.readOnly === undefined ? {} : { readOnly: snapshot.readOnly }),
        ...(snapshot.publicationAttention === undefined
          ? {}
          : { publicationAttention: snapshot.publicationAttention }),
      };
    },
    async readForReview() {
      try {
        return await transport.read();
      } catch (error) {
        const missing = documentCurrentMissingReview(error, target);
        if (missing) return missing;
        throw error;
      }
    },
    async resolve(review) {
      const result = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.resolveFileMutation,
        {
          environmentId: target.environmentId,
          input: { ...input, ...review, choice: "accept-current" },
        },
        options,
      );
      if (result._tag === "Failure") throw result.cause;
      return { revision: result.value.revision };
    },
    describeAttention: describeDocumentPublicationAttention,
    describeOutcome: documentPublicationOutcome,
    classifyFailure: classifyMarkdownPersistenceFailure,
    subscribe(callbacks) {
      const changes = projectEnvironment.fileChanges({
        environmentId: target.environmentId,
        input,
      });
      const connection = environmentCatalog.stateAtom(target.environmentId);
      let lastChange: object | undefined;
      let lastConnected: boolean | undefined;
      const stopChanges = appAtomRegistry.subscribe(
        changes,
        (result) => {
          const change = Option.getOrUndefined(AsyncResult.value(result));
          if (change === undefined || change === lastChange) return;
          lastChange = change;
          callbacks.hint(change._tag);
        },
        { immediate: true },
      );
      const stopConnection = appAtomRegistry.subscribe(
        connection,
        (result) => {
          const state = Option.getOrUndefined(AsyncResult.value(result));
          if (state === undefined) return;
          const connected = state.phase === "connected";
          if (connected === lastConnected) return;
          const reconnecting = lastConnected === false && connected;
          lastConnected = connected;
          callbacks.connected(connected);
          if (reconnecting) callbacks.hint("reconnected");
        },
        { immediate: true },
      );
      return () => {
        stopChanges();
        stopConnection();
      };
    },
    project(snapshot) {
      if (
        snapshot.draftSource !== projectedSource ||
        snapshot.baselineRevision !== projectedRevision
      ) {
        projectedSource = snapshot.draftSource;
        projectedRevision = snapshot.baselineRevision;
        setProjectFileQueryData(
          target.environmentId,
          target.cwd,
          target.relativePath,
          snapshot.draftSource,
          snapshot.baselineRevision,
        );
      }
      if (
        !snapshot.pending &&
        snapshot.attention === null &&
        snapshot.error === null &&
        (wasPending || snapshot.baselineRevision !== confirmedRevision)
      ) {
        confirmedRevision = snapshot.baselineRevision;
        confirmProjectFileQueryData(
          target.environmentId,
          target.cwd,
          target.relativePath,
          snapshot.draftSource,
          snapshot.baselineRevision,
        );
      }
      wasPending = snapshot.pending;
    },
  };
  return transport;
}
