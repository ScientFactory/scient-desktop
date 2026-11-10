// @effect-diagnostics nodeBuiltinImport:off -- Share builds draw the redaction id key with Node's crypto.
import * as NodeCrypto from "node:crypto";

import { CloudConversation, type SnapshotSidecar } from "@scientfactory/scient-cloud/api";
import { DEFAULT_CLOUD_LIMITS } from "@scientfactory/scient-cloud/limits";
import {
  type ScientCloudShareBuild,
  type ScientCloudShareBuildRequest,
  ScientCloudError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { AccountsService } from "../accounts/AccountsService.ts";
import { ConversationSnapshotService } from "../conversationExport/ConversationSnapshotService.ts";
import { ConversationExtras } from "./ConversationExtras.ts";
import {
  markAttachments,
  readBounded,
  sha256Hex,
  snapshotAttachments,
  withContentDigest,
} from "./cloudAttachments.ts";
import { Redactor, redactSection } from "./shareRedaction.ts";

/** A built share; `blobs` carry local file paths the HTTP layer turns into signed URLs. */
export interface BuiltShare extends Omit<ScientCloudShareBuild, "blobs"> {
  readonly blobs: ReadonlyArray<
    Omit<ScientCloudShareBuild["blobs"][number], "relativeUrl"> & { readonly path: string }
  >;
}

const TEXT_ATTACHMENT = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|toml|x-sh|javascript))/u;
/** Text attachments above this are carried unsearched, like binary ones. */
const SEARCHED_TEXT_MAX_BYTES = 8 * 1024 * 1024;
/** A share carries files up to the cloud's per-file limit; larger ones are left out. */
const CARRIED_MAX_BYTES = DEFAULT_CLOUD_LIMITS.maxBlobBytes;

export class ShareBuilder extends Context.Service<
  ShareBuilder,
  {
    readonly build: (
      request: ScientCloudShareBuildRequest,
    ) => Effect.Effect<BuiltShare, ScientCloudError>;
  }
>()("t3/scient/cloud/ShareBuilder") {}

const encodeConversation = Schema.encodeEffect(Schema.fromJsonString(CloudConversation));

const shareError = (reason: ScientCloudError["reason"], message: string) =>
  new ScientCloudError({ reason, message });

const make = Effect.gen(function* () {
  const snapshots = yield* ConversationSnapshotService;
  const fileSystem = yield* FileSystem.FileSystem;
  const accounts = yield* Effect.serviceOption(AccountsService);
  const extras = yield* ConversationExtras;
  const idKey = new Uint8Array(NodeCrypto.randomBytes(32));

  const savedSecrets = Effect.gen(function* () {
    const service = Option.getOrUndefined(accounts);
    if (service?.redactionValues === undefined) return [];
    const values = yield* service.redactionValues;
    return values.map(Redacted.value);
  });

  const build = Effect.fn("ShareBuilder.build")(function* (request: ScientCloudShareBuildRequest) {
    const captured = yield* snapshots
      .capture({
        threadId: request.threadId,
        selection: {
          workLog: request.workLog,
          reasoning: request.reasoning,
          throughMessageId: null,
        },
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ConversationThreadNotFoundError"
            ? shareError("thread-not-found", "This conversation no longer exists.")
            : error._tag === "ScientConversationExportError" && error.reason === "too-large"
              ? shareError("too-large", error.message)
              : shareError("cloud-unavailable", "This conversation could not be read for sharing."),
        ),
      );
    const redactor = new Redactor({
      savedSecrets: yield* savedSecrets,
      keep: request.keep,
      idKey,
      scope: request.threadId,
    });
    const excluded = new Set<string>(request.excludeMessageIds);
    const { contentDigest: _captured, ...source } = captured.snapshot;
    const messages = source.messages
      .filter((message) => !excluded.has(message.id))
      .map((message, index) => ({ ...message, n: index + 1 }));

    // One file in memory at a time; only hashes are kept. Text holding anything the transcript
    // would redact is left out whole (the person can keep each one).
    let binaryNotSearched = 0;
    const carried = new Map<string, { path: string; sha256: string; bytes: number }>();
    for (const attachment of snapshotAttachments({ ...source, messages })) {
      const path = captured.attachmentFiles.get(attachment.localId);
      if (!attachment.available || path === undefined || carried.has(attachment.localId)) continue;
      const bytes = yield* readBounded(fileSystem, path, CARRIED_MAX_BYTES);
      if (bytes === null) continue;
      const searchable =
        TEXT_ATTACHMENT.test(attachment.mimeType) && bytes.byteLength <= SEARCHED_TEXT_MAX_BYTES;
      if (!searchable) binaryNotSearched += 1;
      if (
        searchable &&
        redactor.holdsPrivateText(new TextDecoder().decode(bytes)) &&
        redactor.excludeItem(
          { field: "attachment", itemId: attachment.localId },
          "Attachment with private text",
        )
      )
        continue;
      carried.set(attachment.localId, { path, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
    }

    const redactedContent = markAttachments(
      {
        ...source,
        thread: redactSection(redactor, "thread", source.thread),
        provenance: redactSection(redactor, "provenance", source.provenance),
        messages: redactSection(redactor, "messages", messages),
        reasoning: redactSection(redactor, "reasoning", source.reasoning),
        workLog: redactSection(redactor, "workLog", source.workLog),
        proposedPlans: redactSection(redactor, "proposedPlans", source.proposedPlans),
        questionAnswers: redactSection(redactor, "questionAnswers", source.questionAnswers),
        warnings: redactSection(redactor, "warnings", source.warnings),
      },
      (localId) => carried.has(localId),
    );
    const snapshot = withContentDigest(redactedContent);

    // Names come from the redacted document, so a blob never carries what the text hid.
    const byLocalId = new Map(snapshotAttachments(snapshot).map((a) => [a.localId, a] as const));
    const blobs: Array<BuiltShare["blobs"][number]> = [];
    const sidecarAttachments: Array<NonNullable<SnapshotSidecar["attachments"]>[number]> = [];
    for (const [localId, file] of carried) {
      const attachment = byLocalId.get(localId);
      if (attachment === undefined) continue;
      sidecarAttachments.push({ localId, sha256: file.sha256, bytes: file.bytes });
      blobs.push({
        localId,
        sha256: file.sha256,
        bytes: file.bytes,
        name: attachment.name,
        mimeType: attachment.mimeType,
        path: file.path,
      });
    }
    const { sidecar: extra } = yield* extras.read(request.threadId, snapshot);
    const sidecar = {
      ...redactSection(redactor, "sidecar", extra),
      ...(sidecarAttachments.length === 0 ? {} : { attachments: sidecarAttachments }),
    };
    const document: CloudConversation = {
      snapshot,
      ...(Object.keys(sidecar).length === 0 ? {} : { sidecar }),
    };
    const report = redactor.report();
    return {
      documentJson: yield* encodeConversation(document).pipe(
        Effect.mapError(() => shareError("cloud-unavailable", "This share could not be prepared.")),
      ),
      contentDigest: snapshot.contentDigest,
      redactions: report.redactions,
      kept: report.kept,
      coverage: {
        savedSecretsSearched: redactor.savedSecretCount,
        binaryAttachmentsNotSearched: binaryNotSearched,
      },
      blobs,
    } satisfies BuiltShare;
  });

  return ShareBuilder.of({ build });
});

export const layer = Layer.effect(ShareBuilder, make);
