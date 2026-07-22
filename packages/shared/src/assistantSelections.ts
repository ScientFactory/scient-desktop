// FILE: assistantSelections.ts
// Purpose: Share persisted-prompt cleanup used when conversation history is copied.
// Layer: Shared text normalization

const EMBEDDED_ASSISTANT_SELECTIONS_PATTERN =
  /\n*<assistant_selection>\n[\s\S]*?\n<\/assistant_selection>(?=\n*(<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*)?(<file_comments>\n[\s\S]*?\n<\/file_comments>\s*)?(<pasted_text>\n[\s\S]*?\n<\/pasted_text>\s*)?$)/;

export function stripEmbeddedAssistantSelections(prompt: string): string {
  return prompt.replace(EMBEDDED_ASSISTANT_SELECTIONS_PATTERN, "");
}
