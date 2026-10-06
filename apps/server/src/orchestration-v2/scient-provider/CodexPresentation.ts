import { ProviderCitationPresentationSource, type RuntimeCitationSource } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
