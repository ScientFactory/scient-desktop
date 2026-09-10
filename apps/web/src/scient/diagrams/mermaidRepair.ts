import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
  type MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { captureAssistantTextRange } from "~/lib/assistantTextSelection";
import { markdownFenceCopySource } from "../presentation/presentationExport";
import { MERMAID_VERSION } from "./mermaidRuntime";

const REPAIR_INSTRUCTION = `Please fix this Mermaid diagram so it renders in Scient (Mermaid ${MERMAID_VERSION}). Preserve its intended meaning and return the corrected Mermaid code block.`;

export function buildMermaidRepairRequest(source: string, diagnostic: string): string {
  return [
    REPAIR_INSTRUCTION,
    "Diagram source:",
    markdownFenceCopySource(source, "mermaid", undefined).trimEnd(),
    "Renderer error:",
    markdownFenceCopySource(diagnostic, "text", undefined).trimEnd(),
  ].join("\n\n");
}

/** Quote the real displayed source. If it is hidden, cite the visible error and
 * include the source in the comment instead. Never invent source offsets or
 * change the selection/source visibility merely to add a composer capsule.
 */
export function createMermaidRepairCitation(
  identity: ScopedThreadRef & { messageId: MessageId },
  errorElement: HTMLElement,
  source: string,
  diagnostic: string,
): AssistantCitation | null {
  const viewport = errorElement.closest<HTMLElement>("[data-assistant-citation-viewport]");
  if (!viewport) return null;
  const sourceElement = errorElement
    .closest("[data-scient-visual-card]")
    ?.querySelector("pre code");
  const quoteSource =
    source.trim().length > 0 &&
    sourceElement?.textContent === source &&
    !sourceElement.closest("[hidden]");
  const range = errorElement.ownerDocument.createRange();
  range.selectNodeContents(quoteSource ? sourceElement : errorElement);
  const captured = captureAssistantTextRange(viewport, range);
  if (
    !captured ||
    captured.source.dataset.assistantCitationSource !== identity.messageId ||
    captured.source.dataset.assistantCitationEnvironment !== identity.environmentId ||
    captured.source.dataset.assistantCitationThread !== identity.threadId ||
    captured.selector.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH
  ) {
    return null;
  }
  const comment = quoteSource
    ? [
        REPAIR_INSTRUCTION,
        "Renderer error:",
        markdownFenceCopySource(diagnostic, "text", undefined).trimEnd(),
      ].join("\n\n")
    : buildMermaidRepairRequest(source, diagnostic);
  // Keep the existing citation contract; do not silently discard source/error context.
  if (comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return null;
  return { version: 1, ...identity, ...captured.selector, comment };
}

type RepairComposer = Pick<ChatComposerHandle, "readSnapshot" | "citeAssistantText">;

/** Use the mounted editor so draft text, attachments and queue-edit state survive. */
export function addMermaidRepairToComposer(
  composer: RepairComposer | null | undefined,
  citation: AssistantCitation,
): boolean {
  if (!composer) return false;
  const current = composer.readSnapshot().value;
  if (
    collectAssistantCitations(current).some(
      ({ citation: existing }) =>
        existing.environmentId === citation.environmentId &&
        existing.threadId === citation.threadId &&
        existing.messageId === citation.messageId &&
        existing.text === citation.text &&
        existing.comment === citation.comment,
    )
  ) {
    return true;
  }
  // Insertion owns deferred focus after the controlled editor has updated.
  // Focusing synchronously here emits the old editor snapshot through onChange
  // and overwrites the newly queued draft.
  return composer.citeAssistantText(citation);
}
