import type { ComputeExecutionRecord, NotebookCellRun } from "@t3tools/contracts";

import type { NotebookCellView } from "@t3tools/contracts";

/** A short hash, so a cell can tell whether its outputs came from the code it shows now. */
/** What a notebook keeps about a finished run, so it can tell later if the cell has changed. */
export function notebookCellRun(execution: ComputeExecutionRecord): NotebookCellRun {
  const { startedAt, finishedAt } = execution.result ?? {};
  return {
    execution: execution.request.executionId,
    code: notebookCodeHash(execution.request.code),
    at: finishedAt ?? execution.request.submittedAt,
    ms:
      startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
  };
}

export function notebookCodeHash(code: string): string {
  let hash = 0x811c9dc5;
  const text = code.trimEnd();
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Why a cell's outputs may no longer match: its own code, or something it reads. */
export type NotebookStaleness = "edited" | "upstream";

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const COMMENT = /(^|\s)#.*$/gm;
const ASSIGNED = new RegExp(
  `^[ \\t]*(${NAME}(?:\\s*,\\s*${NAME})*)\\s*(?:[-+*/%|&^]?=(?!=)|<<?-)`,
  "gm",
);
const CHANGED_PART = new RegExp(
  `^[ \\t]*(${NAME})(?:\\.[\\w.]+|\\[[^\\]\\n]*\\])+\\s*[-+*/]?=(?!=)`,
  "gm",
);
const DECLARED = new RegExp(`^[ \\t]*(?:async\\s+)?(?:def|class|function)\\s+(${NAME})`, "gm");
const LOOPED = new RegExp(`^[ \\t]*for\\s+(${NAME}(?:\\s*,\\s*${NAME})*)\\s+in\\b`, "gm");
const ALIASED = new RegExp(`\\bas\\s+(${NAME})`, "g");
const IMPORTED = /^[ \t]*(?:from\s+\S+\s+)?import\s+(.+)$/gm;
const TABLE = new RegExp(
  `\\bcreate\\s+(?:or\\s+replace\\s+)?(?:temp(?:orary)?\\s+)?(?:table|view)\\s+(?:if\\s+not\\s+exists\\s+)?(${NAME})`,
  "gi",
);

function namesFrom(pattern: RegExp, code: string): string[] {
  return [...code.matchAll(pattern)].flatMap((match) => (match[1] ?? "").split(/\s*,\s*/));
}

/** Names a cell binds or changes. A hint across languages, not a parser. */
export function definedNames(source: string): ReadonlySet<string> {
  const code = source.replace(COMMENT, "$1");
  const imported = [...code.matchAll(IMPORTED)].flatMap((match) =>
    (match[1] ?? "").split(",").map(
      (part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.split(".")[0]
          ?.trim() ?? "",
    ),
  );
  return new Set(
    [
      ...namesFrom(ASSIGNED, code),
      ...namesFrom(CHANGED_PART, code),
      ...namesFrom(DECLARED, code),
      ...namesFrom(LOOPED, code),
      ...namesFrom(ALIASED, code),
      ...namesFrom(TABLE, code).map((name) => name.toLowerCase()),
      ...imported,
    ].filter((name) => name !== ""),
  );
}

function usedNames(source: string): ReadonlySet<string> {
  const names = source.replace(COMMENT, "$1").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return new Set(names.flatMap((name) => [name, name.toLowerCase()]));
}

/**
 * Cells whose outputs may not match what the notebook now shows: edited since they ran, or
 * reading a name that an earlier cell changed afterwards. Reading top to bottom carries
 * staleness down the notebook. A cell Scient never ran has no record, so it is never flagged.
 */
export function staleNotebookCells(
  cells: ReadonlyArray<NotebookCellView>,
): ReadonlyMap<string, NotebookStaleness> {
  const stale = new Map<string, NotebookStaleness>();
  const earlier: Array<{
    readonly names: ReadonlySet<string>;
    readonly at: string | null;
    readonly stale: boolean;
  }> = [];
  for (const cell of cells) {
    if (cell.cellType !== "code") continue;
    const { run } = cell;
    if (run !== null) {
      if (notebookCodeHash(cell.source) !== run.code) {
        stale.set(cell.id, "edited");
      } else {
        const used = usedNames(cell.source);
        const changedAbove = earlier.some(
          (entry) =>
            (entry.stale || (entry.at !== null && entry.at > run.at)) &&
            [...entry.names].some((name) => used.has(name)),
        );
        if (changedAbove) stale.set(cell.id, "upstream");
      }
    }
    earlier.push({
      names: definedNames(cell.source),
      at: run?.at ?? null,
      stale: stale.has(cell.id),
    });
  }
  return stale;
}

/** Markdown heading positions for the notebook outline and portable section folds. */
export function notebookHeadings(source: string): ReadonlyArray<{
  readonly level: number;
  readonly text: string;
  readonly line: number;
}> {
  const headings = [];
  let fence: string | undefined;
  let paragraph: { text: string; line: number } | undefined;
  for (const [line, text] of source.split(/\r?\n/u).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    if (fence !== undefined) {
      if (marker?.[1]?.startsWith(fence) && marker[2]?.trim() === "") fence = undefined;
      continue;
    }
    if (marker?.[1] !== undefined) {
      fence = marker[1];
      paragraph = undefined;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/u.exec(text);
    if (heading?.[1] !== undefined) {
      headings.push({
        level: heading[1].length,
        text: (heading[2] ?? "").replace(/(?:^|\s)#+\s*$/u, "").trim(),
        line,
      });
      paragraph = undefined;
    } else if (paragraph !== undefined && /^ {0,3}(=+|-+)[ \t]*$/u.test(text)) {
      headings.push({ ...paragraph, level: text.trimStart().startsWith("=") ? 1 : 2 });
      paragraph = undefined;
    } else {
      paragraph = /^ {0,3}[^\s>#*+-]/u.test(text) ? { text: text.trim(), line } : undefined;
    }
  }
  return headings;
}
