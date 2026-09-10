import type {
  MarkdownSaveIntent,
  MarkdownPersistenceSnapshot,
} from "@scientfactory/scient-markdown";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  ProjectReadFileError,
  ProjectWriteFileError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";

import { environmentCatalog } from "~/connection/catalog";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { normalizeMarkdownReadSnapshot } from "./markdownReadSnapshot";

export interface MarkdownPersistenceTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export type MarkdownPersistenceFailureKind =
  | "conflict"
  | "transient"
  | "operation"
  | "disconnected"
  | "terminal";

const isReadFailure = Schema.is(ProjectReadFileError);
const isWriteFailure = Schema.is(ProjectWriteFileError);
const isConnectionTransient = Schema.is(ConnectionTransientError);
const isRpcFailure = Schema.is(RpcClientError.RpcClientError);

function classifyReason(error: unknown): MarkdownPersistenceFailureKind {
  if (isWriteFailure(error) || isReadFailure(error)) {
    if (error.failure === "revision_conflict") return "conflict";
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
  const first = kinds[0]!;
  return kinds.every((kind) => kind === first) ? first : "terminal";
}

export interface MarkdownPersistenceTransport {
  readonly write: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly read: () => Promise<{
    readonly source: string;
    readonly revision: string;
    readonly truncated?: boolean;
    readonly readOnly?: boolean;
  }>;
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
  return {
    async write(intent) {
      const result = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.writeFile,
        {
          environmentId: target.environmentId,
          input: { ...input, contents: intent.source, expectedRevision: intent.expectedRevision },
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
      };
    },
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
      if (!snapshot.pending && (wasPending || snapshot.baselineRevision !== confirmedRevision)) {
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
}
