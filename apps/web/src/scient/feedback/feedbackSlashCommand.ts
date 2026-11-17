import type { ProviderDriverKind, ServerProviderSlashCommand } from "@t3tools/contracts";

/**
 * `/feedback` opens "Send feedback to Scient" in the desktop app. Codex's own `/feedback`
 * (send the thread and Codex logs to OpenAI) stays available there as `/feedback-openai`, so one
 * name never means two things.
 */
const CODEX_OPENAI_FEEDBACK_COMMAND = "feedback-openai";

/** `/feedback` with optional words after it; the words become the report's message. */
export function parseScientFeedbackCommand(text: string): { readonly message: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  return match ? { message: match[1]?.trim() ?? "" } : null;
}

/** `/feedback-openai [reason]` rewritten as the `/feedback [reason]` Codex's upload reads. */
export function codexOpenAiFeedbackText(text: string): string | null {
  const match = /^\/feedback-openai(?=\s|$)([\s\S]*)$/iu.exec(text.trim());
  return match ? `/feedback${match[1] ?? ""}` : null;
}

/** Shows Codex's `/feedback` under its OpenAI name when Scient's own `/feedback` is present. */
export function renameCodexFeedbackCommand(
  provider: ProviderDriverKind,
  command: ServerProviderSlashCommand,
  scientFeedbackAvailable: boolean,
): ServerProviderSlashCommand {
  return scientFeedbackAvailable && provider === "codex" && command.name === "feedback"
    ? { ...command, name: CODEX_OPENAI_FEEDBACK_COMMAND }
    : command;
}
