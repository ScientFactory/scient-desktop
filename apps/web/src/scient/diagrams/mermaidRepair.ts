import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { markdownFenceCopySource } from "../presentation/presentationExport";
import { MERMAID_VERSION } from "./mermaidRuntime";

export function buildMermaidRepairRequest(source: string, diagnostic: string): string {
  return [
    `Please fix this Mermaid diagram so it renders in Scient (Mermaid ${MERMAID_VERSION}). Preserve its intended meaning and return the corrected Mermaid code block.`,
    "Diagram source:",
    markdownFenceCopySource(source, "mermaid", undefined).trimEnd(),
    "Renderer error:",
    markdownFenceCopySource(diagnostic, "text", undefined).trimEnd(),
  ].join("\n\n");
}

type RepairComposer = Pick<ChatComposerHandle, "readSnapshot" | "insertTextAtEnd" | "focusAtEnd">;

/** Use the mounted editor so draft text, attachments and queue-edit state survive. */
export function addMermaidRepairToComposer(
  composer: RepairComposer | null | undefined,
  request: string,
): boolean {
  if (!composer) return false;
  const current = composer.readSnapshot().value;
  if (current.endsWith(request)) {
    composer.focusAtEnd();
    return true;
  }
  // Insertion owns deferred focus after the controlled editor has updated.
  // Focusing synchronously here emits the old editor snapshot through onChange
  // and overwrites the newly queued draft.
  return composer.insertTextAtEnd(`${current.length > 0 ? "\n\n" : ""}${request}`);
}
