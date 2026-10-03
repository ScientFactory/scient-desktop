import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";
import {
  toolGroupAction,
  type WorkLogPresentationEntry,
} from "@t3tools/client-runtime/work-log/presentation";
import { createLucideIcon } from "lucide-react";

/** Line weight of every icon in a conversation's traces (actions, reasoning, plans, setup). */
export const TRACE_ICON_STROKE = "stroke-[1.6]";

/** Lucide's square-terminal with the prompt 1.5 units lower, nearer the middle of the box. */
export const SquareTerminalLowered = createLucideIcon("square-terminal-lowered", [
  ["path", { d: "m7 12.5 2-2-2-2", key: "prompt" }],
  ["path", { d: "M11 14.5h4", key: "cursor" }],
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2", key: "frame" }],
]);

const LIST_PROGRAMS = new Set(["ls", "tree", "find", "fd", "eza", "exa", "dir"]);
const FETCH_PROGRAMS = new Set(["curl", "wget", "http", "https", "xh"]);
const LIST_TOOL_TITLES = new Set([
  "ls",
  "find",
  "glob",
  "list_directory",
  "list directory",
  "listed directory",
  "found files",
]);

/** A command that lists files or fetches from the web, by the program it runs. */
export function traceCommandKind(command: string | undefined): "list" | "fetch" | null {
  const program = command ? commandProgramName(command)?.toLowerCase() : undefined;
  if (!program) return null;
  if (LIST_PROGRAMS.has(program)) return "list";
  if (FETCH_PROGRAMS.has(program)) return "fetch";
  return null;
}

/** An agent tool that lists files or folders, by its name or title. */
export function isListFilesTool(toolTitle: string | undefined): boolean {
  return toolTitle !== undefined && LIST_TOOL_TITLES.has(toolTitle.trim().toLowerCase());
}

/** The tool name a provider recorded in a row's tool data, when it has one. */
export function traceToolName(toolData: unknown): string | undefined {
  if (toolData === null || typeof toolData !== "object") return undefined;
  const record = toolData as Record<string, unknown>;
  const name = record.toolName ?? record.tool;
  return typeof name === "string" ? name : undefined;
}

/** Scient's own skill tools, under every provider's spelling (`mcp__t3-code__…`, `t3-code · …`). */
export function isScientSkillTool(names: ReadonlyArray<string | undefined>): boolean {
  return names.some((name) => name !== undefined && /(?:^|[_.\s·/])scient_skills?_/u.test(name));
}

/** Trace icons Scient picks from what an action did, ahead of the shared category icons. */
export type TraceIconOverride = "shield" | "skill" | "image" | "folder" | "globe";

/**
 * The icon an action gets from what it did: an approval, a Scient skill tool, an
 * image view, a file listing, or a command that lists files or fetches from the
 * web. Other actions keep their category's icon.
 */
export function traceIconOverride(
  entry: Pick<
    WorkLogPresentationEntry,
    | "label"
    | "toolTitle"
    | "toolData"
    | "itemType"
    | "viewedImagePath"
    | "command"
    | "sourceActivityKind"
    | "requestKind"
    | "changedFiles"
    | "tone"
  >,
): TraceIconOverride | undefined {
  if (
    entry.sourceActivityKind === "approval.requested" ||
    entry.sourceActivityKind === "approval.resolved"
  ) {
    return "shield";
  }
  if (isScientSkillTool([entry.toolTitle, entry.label, traceToolName(entry.toolData)])) {
    return "skill";
  }
  if (entry.itemType === "image_view" || entry.viewedImagePath !== undefined) return "image";
  if (isListFilesTool(entry.toolTitle ?? entry.label)) return "folder";
  if (toolGroupAction(entry) !== "command") return undefined;
  const commandKind = traceCommandKind(entry.command);
  if (commandKind === "list") return "folder";
  if (commandKind === "fetch") return "globe";
  return undefined;
}

/** The override every entry of a group shares, if they all share one. */
export function groupTraceIconOverride(
  entries: ReadonlyArray<Parameters<typeof traceIconOverride>[0]>,
): TraceIconOverride | undefined {
  const [first, ...rest] = entries.map(traceIconOverride);
  return first !== undefined && rest.every((icon) => icon === first) ? first : undefined;
}
