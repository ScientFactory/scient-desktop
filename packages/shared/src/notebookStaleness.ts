import type { NotebookCellView } from "@t3tools/contracts";

/** A short hash, so a cell can tell whether its outputs came from the code it shows now. */
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
