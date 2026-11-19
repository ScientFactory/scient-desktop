import {
  SCIENT_MCP_TOOLS,
  scientSkillDisplayName,
} from "@t3tools/shared/scientMcpToolPresentation";
import type { T3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

type ActivityStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped" | "other";

// Whole sentences with the skill's name as a variable, so each language orders them itself.
const SKILL_SENTENCES: ReadonlyMap<T3McpToolDefinition | undefined, string> = new Map([
  [
    SCIENT_MCP_TOOLS.t3_skill_load,
    msg(
      "{status, select, inProgress {Loading {skill}} completed {Used {skill}} failed {Failed to load {skill}} declined {Declined to load {skill}} stopped {Stopped loading {skill}} other {Loading {skill}}}",
    ),
  ],
  [
    SCIENT_MCP_TOOLS.t3_skill_save,
    msg(
      "{status, select, inProgress {Saving {skill}} completed {Saved {skill}} failed {Failed to save {skill}} declined {Declined to save {skill}} stopped {Stopped saving {skill}} other {Saving {skill}}}",
    ),
  ],
  [
    SCIENT_MCP_TOOLS.t3_skill_read,
    msg(
      "{status, select, inProgress {Reading {skill}} completed {Read {skill}} failed {Failed to read {skill}} declined {Declined to read {skill}} stopped {Stopped reading {skill}} other {Reading {skill}}}",
    ),
  ],
  [
    SCIENT_MCP_TOOLS.t3_skill_read_resource,
    msg(
      "{status, select, inProgress {Reading a file of {skill}} completed {Read a file of {skill}} failed {Failed to read a file of {skill}} declined {Declined to read a file of {skill}} stopped {Stopped reading a file of {skill}} other {Reading a file of {skill}}}",
    ),
  ],
]);

/** A Scient skill tool's work-log row, naming the skill its input names. */
export function scientSkillActivityLabel(
  definition: T3McpToolDefinition,
  input: Record<string, unknown> | null,
  status: ActivityStatus,
  resolve: MFunctionType,
): string | undefined {
  const sentence = SKILL_SENTENCES.get(definition);
  if (sentence === undefined) return undefined;
  const skill = scientSkillDisplayName(input);
  return skill === null ? undefined : resolve(sentence, { status, skill });
}
