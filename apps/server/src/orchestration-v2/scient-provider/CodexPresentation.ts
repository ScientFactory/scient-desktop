import {
  ProviderCitationPresentationSource,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeCitationSource,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { materializeGeneratedImageAttachment } from "../../generatedImageAttachments.ts";
import type { ProviderAdapterProtocolError, ProviderAdapterV2Event } from "../ProviderAdapter.ts";

import {
  canRenderProviderCitationMarkdown,
  extractCodexProseCitations,
  renderProviderCitationMarkdown,
} from "../providerCitationMarkdown.ts";

const decodeCitationPresentationSource = Schema.decodeUnknownOption(
  ProviderCitationPresentationSource,
);

/** Preserve unresolved provider syntax with inert provenance for portable presentation. */
export function codexCitationPresentation(
  context: { readonly citationSources: ReadonlyMap<string, RuntimeCitationSource> },
  item: { readonly text: string },
  completed: boolean,
) {
  const citations = completed ? extractCodexProseCitations(item.text) : [];
  const sources = Array.from(context.citationSources.values());
  const text =
    citations.length > 0 && canRenderProviderCitationMarkdown({ citations, sources })
      ? renderProviderCitationMarkdown({ text: item.text, citations, sources })
      : item.text;
  const sourceIds = new Set(citations.flatMap((citation) => citation.sourceIds));
  const boundedSources = sources
    .filter((source) => sourceIds.has(source.id))
    .flatMap((source) => {
      const decoded = decodeCitationPresentationSource(source);
      return Option.isSome(decoded) ? [decoded.value] : [];
    })
    .slice(0, 128);
  const citationPresentation =
    citations.length > 0 && text === item.text
      ? { format: "codex-private-v1" as const, sources: boundedSources }
      : undefined;
  return { text, citationPresentation };
}

/** Diagnostics retain the rejection cause without logging native paths or payloads. */
export function generatedImageImportFailureReason(cause: unknown): string {
  const knownReasons: Readonly<Record<string, string>> = {
    "Generated image is not a regular file.": "not_regular_file",
    "Generated image is empty or exceeds the chat image size limit.": "invalid_size",
    "Generated image escaped its authorized provider-thread directory.": "outside_authorized_root",
    "Generated image is outside its authorized provider-thread directory.":
      "outside_authorized_root",
    "Generated image identity changed while it was being opened.": "identity_changed",
    "Generated image changed while it was being read.": "content_changed",
    "Generated image has an unsupported raster format.": "unsupported_format",
    "Persisted generated image extension does not match its bytes.": "persisted_format_mismatch",
    "Generated-image replay resolved to different persisted bytes.": "replay_bytes_mismatch",
    "Generated-image replay resolved to different persisted bytes or format.":
      "replay_bytes_mismatch",
    "Concurrent generated-image replays produced different bytes.": "concurrent_bytes_mismatch",
  };
  const knownReason = cause instanceof Error ? knownReasons[cause.message] : undefined;
  if (knownReason !== undefined) return knownReason;
  const code = typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  return typeof code === "string" &&
    ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "EIO", "ENOSPC", "EROFS"].includes(code)
    ? code
    : "unknown_import_failure";
}

type ImageGenerationItem = Extract<
  CodexSchema.ServerNotification__ThreadItem,
  { readonly type: "imageGeneration" }
>;
type NodeUpdated = Extract<ProviderAdapterV2Event, { readonly type: "node.updated" }>;
type MessageUpdated = Extract<ProviderAdapterV2Event, { readonly type: "message.updated" }>;
type TurnItemUpdated = Extract<ProviderAdapterV2Event, { readonly type: "turn_item.updated" }>;

/** Import a generated image from its authorized Codex homes and present it on the turn. */
export const emitCodexGeneratedImage = <
  Context extends {
    readonly projectionThreadId: ThreadId;
    readonly providerThread: {
      readonly nativeThreadRef: { readonly nativeId: string | null } | null;
    };
  },
  LayoutError,
  BuildError,
  EmitError,
>(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly attachmentsDir: string;
  readonly path: Path.Path;
  readonly image: ImageGenerationItem;
  readonly context: Context;
  readonly resolveLayout: Effect.Effect<
    {
      readonly effectiveHomePath?: string | undefined;
      readonly sharedHomePath?: string | undefined;
    },
    LayoutError
  >;
  readonly toProtocolError: (detail: string, payload?: unknown) => ProviderAdapterProtocolError;
  readonly buildAgentMessageArtifacts: (
    context: Context,
    item: { readonly id: string; readonly text: string },
    completed: boolean,
  ) => Effect.Effect<
    {
      readonly node: NodeUpdated["node"];
      readonly message: MessageUpdated["message"];
      readonly turnItem: TurnItemUpdated["turnItem"];
    },
    BuildError
  >;
  readonly emitProviderEvent: (event: ProviderAdapterV2Event) => Effect.Effect<unknown, EmitError>;
}) =>
  Effect.gen(function* () {
    const { context, image, path, toProtocolError, buildAgentMessageArtifacts, emitProviderEvent } =
      input;
    const CODEX_PROVIDER = input.driver;
    const layout = yield* input.resolveLayout;
    const homes = Array.from(
      new Set(
        [layout.effectiveHomePath, layout.sharedHomePath].filter(
          (home): home is string => home !== undefined,
        ),
      ),
    );
    const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
    const importFailures: Array<{ readonly candidate: number; readonly reason: string }> = [];
    let importFailureReason = "candidate_import_failed";
    const imported = yield* Effect.gen(function* () {
      if (image.failure != null || image.status === "failed") {
        importFailureReason = "provider_generation_failed";
        return yield* toProtocolError("Codex image generation failed.");
      }
      if (
        !nativeThreadId ||
        /[\\/]/u.test(nativeThreadId) ||
        path.basename(nativeThreadId) !== nativeThreadId ||
        nativeThreadId === "." ||
        nativeThreadId === ".."
      ) {
        importFailureReason = "invalid_native_thread_identity";
        return yield* toProtocolError("Generated image has no valid provider-thread identity.");
      }
      const roots = homes.map((home) => path.join(home, "generated_images", nativeThreadId));
      const candidates = image.savedPath
        ? [image.savedPath]
        : roots.map((root) => path.join(root, `${image.id}.png`));
      if (candidates.length === 0) importFailureReason = "no_authorized_image_candidate";
      return yield* Effect.tryPromise({
        try: async () => {
          for (const [candidate, sourcePath] of candidates.entries()) {
            try {
              return await materializeGeneratedImageAttachment({
                threadId: context.projectionThreadId,
                sourcePath,
                provenanceKey: `${input.instanceId}\0${nativeThreadId}\0${image.id}`,
                allowedSourceRoots: roots,
                attachmentsDir: input.attachmentsDir,
                allowDurableFallbackWhenSourceUnavailable: true,
              });
            } catch (cause) {
              importFailures.push({
                candidate,
                reason: generatedImageImportFailureReason(cause),
              });
              // Another authorized home may hold the image.
            }
          }
          throw new Error("Generated image could not be imported.");
        },
        catch: () =>
          toProtocolError("Generated image could not be imported.", {
            failures: importFailures,
          }),
      });
    }).pipe(Effect.result);
    if (imported._tag === "Failure") {
      yield* Effect.logWarning("orchestration-v2.codex.generated-image-import-failed", {
        instanceId: input.instanceId,
        threadId: context.projectionThreadId,
        reason: importFailureReason,
        failures: importFailures,
      });
    }
    const text =
      imported._tag === "Success"
        ? ""
        : "Codex generated an image, but Scient could not attach it. The image may still be available in Codex's generated images.";
    const artifacts = yield* buildAgentMessageArtifacts(context, { id: image.id, text }, true);
    yield* emitProviderEvent({
      type: "node.updated",
      driver: CODEX_PROVIDER,
      node: artifacts.node,
    });
    yield* emitProviderEvent({
      type: "message.updated",
      driver: CODEX_PROVIDER,
      message: {
        ...artifacts.message,
        attachments: imported._tag === "Success" ? [imported.success] : [],
      },
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: CODEX_PROVIDER,
      turnItem: {
        ...artifacts.turnItem,
        ...(artifacts.turnItem.type === "assistant_message"
          ? { attachments: imported._tag === "Success" ? [imported.success] : [] }
          : {}),
      },
    });
  });
