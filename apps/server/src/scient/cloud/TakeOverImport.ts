/**
 * "Continue on this computer": the renderer has taken the lease; this downloads the cloud copy
 * with this computer's signature, packs it as a `.scic` and runs the ordinary conversation import
 * into the local project with the same repository. The result is a new local thread with a fresh
 * provider session and a handoff on its first turn; sync copies it with `continuedFrom`.
 */
import type { ResolvedAttachmentContent } from "@scientfactory/conversation";
import { CloudConversation } from "@scientfactory/scient-cloud/api";
import {
  type EnvironmentSessionPrincipalShape,
  type ProjectId,
  type ScientCloudTakeOverRequest,
  type ScientCloudTakeOverResult,
  SCIC_FILE_EXTENSION,
  ScientCloudError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ConversationExportFiles } from "../conversationExport/ConversationExportFiles.ts";
import { prepareScicPackage, sha256Digest } from "../conversationFile/ScicWriter.ts";
import {
  CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX,
  ConversationImportStaging,
} from "../conversationImport/ConversationImportStaging.ts";
import { CloudApi } from "./CloudApi.ts";
import { CloudSyncState } from "./CloudSyncState.ts";
import { makeProjectPlacement } from "./CloudSyncSourceLive.ts";

const decodeConversation = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudConversation));

const refused = (message: string) => new ScientCloudError({ reason: "cloud-refused", message });

export class TakeOverImport extends Context.Service<
  TakeOverImport,
  {
    readonly takeOver: (
      request: ScientCloudTakeOverRequest,
      principal: EnvironmentSessionPrincipalShape,
    ) => Effect.Effect<ScientCloudTakeOverResult, ScientCloudError>;
  }
>()("t3/scient/cloud/TakeOverImport") {}

const make = Effect.gen(function* () {
  const api = yield* CloudApi;
  const store = yield* CloudSyncState;
  const projects = yield* ProjectStoreV2;
  const projections = yield* ProjectionStoreV2;
  const lock = yield* Semaphore.make(1);
  const staging = yield* ConversationImportStaging;
  const files = yield* ConversationExportFiles;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const placement = yield* makeProjectPlacement;

  const destinationFor = Effect.fn("TakeOverImport.destination")(function* (
    request: ScientCloudTakeOverRequest,
  ) {
    const active = (yield* projects.list()).filter(
      (project) => project.deletedAt === null && project.archivedAt === null,
    );
    if (request.projectId !== undefined) {
      return active.some((project) => project.projectId === request.projectId)
        ? { _tag: "project" as const, projectId: request.projectId }
        : yield* new ScientCloudError({
            reason: "thread-not-found",
            message: "That project is no longer on this computer.",
          });
    }
    const sameRepository: Array<{ projectId: ProjectId; title: string; exact: boolean }> = [];
    for (const project of active) {
      const place = yield* placement(project.projectId).pipe(Effect.orElseSucceed(() => null));
      if (place === null || place.projectKey !== request.projectKey) continue;
      sameRepository.push({
        projectId: project.projectId,
        title: project.title,
        exact: (place.relativePath ?? undefined) === (request.relativePath ?? undefined),
      });
    }
    const exact = sameRepository.filter((candidate) => candidate.exact);
    if (exact.length === 1) return { _tag: "project" as const, projectId: exact[0]!.projectId };
    const candidates = (sameRepository.length > 0 ? sameRepository : active).map((project) => ({
      projectId: project.projectId,
      title: project.title,
    }));
    return { _tag: "choose" as const, candidates };
  });

  const download = Effect.fn("TakeOverImport.download")(function* (
    userId: string,
    request: ScientCloudTakeOverRequest,
  ) {
    const json = yield* api.getThread(
      userId,
      request.source.environmentId,
      request.source.threadId,
    );
    const document = yield* decodeConversation(new TextDecoder().decode(json)).pipe(
      Effect.mapError(() => refused("The cloud copy of this conversation could not be read.")),
    );
    const attachments = new Map<string, ResolvedAttachmentContent>();
    for (const entry of document.sidecar?.attachments ?? []) {
      const bytes = yield* api.getBlob(userId, entry.sha256).pipe(Effect.orElseSucceed(() => null));
      const digest = bytes === null ? null : sha256Digest(bytes);
      if (bytes === null || digest !== `sha256:${entry.sha256}`) continue;
      attachments.set(entry.localId, { _tag: "bytes", bytes, sha256: digest });
    }
    return { snapshot: document.snapshot, attachments };
  });

  const importPackage = Effect.fn("TakeOverImport.importPackage")(function* (
    request: ScientCloudTakeOverRequest,
    projectId: ProjectId,
    downloaded: Effect.Success<ReturnType<typeof download>>,
    principal: EnvironmentSessionPrincipalShape,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const exportId = `takeover-${yield* random.uuidV4()}`;
    const prepared = prepareScicPackage({
      snapshot: downloaded.snapshot,
      attachments: downloaded.attachments,
      exportValue: Hex.encode(yield* random.randomBytes(6)),
      exportedAt: now,
      exporter: { name: "Scient", version: packageJson.version },
      timeZone: "UTC",
      redact: (text) => text,
    });
    if (prepared._tag !== "ok") {
      return yield* new ScientCloudError({
        reason: prepared._tag === "too-large" ? "too-large" : "cloud-refused",
        message: "This conversation could not be prepared for this computer.",
      });
    }
    const fileName = `conversation${SCIC_FILE_EXTENSION}`;
    const written = yield* files.write({
      exportId,
      fileName,
      content: { _tag: "zip", modifiedAt: now, entries: prepared.value.files },
    });
    const bytes = yield* fileSystem.readFile(written.path);
    const upload = yield* staging.createUpload({ fileName, sizeBytes: bytes.byteLength });
    const token = upload.relativeUrl.slice(CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX.length + 1);
    const claims = yield* staging.validateUploadToken(token);
    if (claims === null) return yield* refused("The conversation could not be staged for import.");
    yield* staging.receiveUpload(claims, Stream.make(bytes));
    const preview = yield* staging.preview(upload.importId);
    return yield* staging.confirm(
      {
        importId: upload.importId,
        packageSha256: preview.package.packageSha256,
        destination: {
          projectId,
          modelSelection: request.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      },
      principal,
    );
  });

  /** A retry or second click returns the conversation already continued here, while it exists. */
  const previousImport = Effect.fn("TakeOverImport.previousImport")(function* (
    request: ScientCloudTakeOverRequest,
  ) {
    const { continuedFrom } = yield* store.get;
    for (const [threadId, from] of Object.entries(continuedFrom)) {
      if (from.env !== request.source.environmentId || from.thread !== request.source.threadId)
        continue;
      const shell = yield* projections
        .getThreadShell(threadId as ThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell !== null) {
        return { _tag: "imported", threadId: shell.id, projectId: shell.projectId } as const;
      }
    }
    return null;
  });

  const takeOver = Effect.fn("TakeOverImport.takeOver")(function* (
    request: ScientCloudTakeOverRequest,
    principal: EnvironmentSessionPrincipalShape,
  ) {
    const { userId } = yield* store.get;
    if (userId === null) {
      return yield* new ScientCloudError({
        reason: "not-enrolled",
        message: "Turn on Cloud copy on this computer first.",
      });
    }
    const previous = yield* previousImport(request);
    if (previous !== null) return previous;
    const destination = yield* destinationFor(request);
    if (destination._tag === "choose") {
      return { _tag: "choose-project", candidates: destination.candidates } as const;
    }
    const downloaded = yield* download(userId, request);
    const result = yield* importPackage(request, destination.projectId, downloaded, principal);
    yield* store.update((state) => ({
      ...state,
      continuedFrom: {
        ...state.continuedFrom,
        [result.threadId]: {
          env: request.source.environmentId,
          thread: request.source.threadId,
          generation: request.generation,
        },
      },
    }));
    return {
      _tag: "imported",
      threadId: result.threadId,
      projectId: destination.projectId,
    } as const;
  });

  return TakeOverImport.of({
    takeOver: Effect.fn("TakeOverImport.takeOverMapped")((request, principal) =>
      lock
        .withPermits(1)(takeOver(request, principal))
        .pipe(
          Effect.catchTags({
            CloudApiError: (error) =>
              Effect.fail(
                new ScientCloudError({
                  reason:
                    error.code === "not_found"
                      ? "thread-not-found"
                      : error.code === "network"
                        ? "cloud-unavailable"
                        : "cloud-refused",
                  message: error.message,
                }),
              ),
            ScientConversationImportError: (error) => Effect.fail(refused(error.message)),
          }),
          Effect.catchIf(
            (error): error is Exclude<typeof error, ScientCloudError> =>
              error._tag !== "ScientCloudError",
            (cause) =>
              Effect.logWarning("Take-over import failed.", { cause }).pipe(
                Effect.andThen(
                  Effect.fail(refused("This conversation could not be continued here.")),
                ),
              ),
          ),
        ),
    ),
  });
});

export const layer = Layer.effect(TakeOverImport, make);
