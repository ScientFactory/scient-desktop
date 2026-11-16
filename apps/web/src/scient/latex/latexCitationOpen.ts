import { latexCitationItems, type CitationItem } from "@scientfactory/scient-sources";

import { isMacPlatform } from "~/lib/utils";

import { latexCommentRanges, maskLatexSource } from "./latexSourceSyntax";

/** Command-click on a Mac, Control-click elsewhere: how a writer follows a citation. */
export function isCitationOpenClick(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform = navigator.platform,
): boolean {
  if (event.button !== 0 || event.altKey || event.shiftKey) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** The works a citation opens: only the key clicked when it names one, else every key. */
export function latexCitationOpenItems(
  keys: string,
  notes: ReadonlyArray<string>,
  clicked: string | null,
): ReadonlyArray<CitationItem> {
  const items = latexCitationItems(keys, notes);
  const one = clicked === null ? [] : items.filter((item) => item.key === clicked);
  return one.length > 0 ? one : items;
}

/** The passage a citation closes, as Quote in my document writes it: `“text” \cite[p.~4]{key}`. */
export function latexQuoteBefore(text: string): string | null {
  const quote = /“([^“”]*)”\s*$/u.exec(text)?.[1]?.trim();
  return quote ? quote : null;
}

export interface LatexSourceCitation {
  readonly items: ReadonlyArray<CitationItem>;
  readonly quote: string | null;
}

// Any `\…cite…` command, as the Library's key rename reads LaTeX.
const COMMAND = /\\([A-Za-z]*cite[A-Za-z]*)\*?/uy;
// biblatex's `\cites(pre)(post)[pre][post]{a}[pre][post]{b}` repeats its key lists.
const MULTICITE = /(?:cites|citetexts)$/u;
const GLOBAL_NOTES = /(?:\s*\([^()]*\)){0,2}/uy;
const KEY_LIST = /\s*((?:\[[^\]]*\]\s*){0,2})\{([^{}]*)\}/uy;
/** How far back a click looks for the command it is in. */
const LOOK_BACK = 2_000;

interface KeyList {
  readonly notes: ReadonlyArray<string>;
  readonly keys: string;
  readonly keysFrom: number;
}

function citationAt(source: string, start: number) {
  COMMAND.lastIndex = start;
  const command = COMMAND.exec(source);
  if (!command) return null;
  let cursor = COMMAND.lastIndex;
  const multi = MULTICITE.test(command[1]!);
  if (multi) {
    GLOBAL_NOTES.lastIndex = cursor;
    cursor += GLOBAL_NOTES.exec(source)![0].length;
  }
  const lists: KeyList[] = [];
  for (;;) {
    KEY_LIST.lastIndex = cursor;
    const list = KEY_LIST.exec(source);
    if (!list) break;
    cursor = KEY_LIST.lastIndex;
    lists.push({
      notes: [...list[1]!.matchAll(/\[([^\]]*)\]/gu)].map((note) => note[1]!),
      keys: list[2]!,
      keysFrom: cursor - 1 - list[2]!.length,
    });
    if (!multi) break;
  }
  return lists.length > 0 ? { end: cursor, lists } : null;
}

function escaped(source: string, at: number): boolean {
  let backslashes = 0;
  while (at - backslashes - 1 >= 0 && source[at - backslashes - 1] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

function clickedKey(list: KeyList, offset: number): string | null {
  let from = list.keysFrom;
  for (const part of list.keys.split(",")) {
    const lead = part.length - part.trimStart().length;
    const key = part.trim();
    if (key && offset >= from + lead && offset <= from + lead + key.length) return key;
    from += part.length + 1;
  }
  return null;
}

/**
 * The citation a click at `offset` lands in: the one key under it, with the postnote only when
 * the command names one key; otherwise every key the command cites. Null outside a citation, in
 * a comment and in verbatim text, which hold no citations; a comment between a command and its
 * arguments, or inside its key list, is skipped as TeX skips it.
 */
export function latexSourceCitationAt(source: string, offset: number): LatexSourceCitation | null {
  if (latexCommentRanges(source).some(({ from, to }) => from < offset && offset <= to)) {
    return null;
  }
  // Offsets and line breaks stay where they are; comments and verbatim text become spaces.
  const live = maskLatexSource(source, { literals: true });
  let start = live.lastIndexOf("\\", offset);
  while (start >= 0 && offset - start <= LOOK_BACK) {
    const citation = escaped(live, start) ? null : citationAt(live, start);
    if (citation) {
      // Citations do not nest: one that ends before the click is the nearest there is.
      if (offset > citation.end) return null;
      const items = citation.lists.flatMap((list) => {
        const key = clickedKey(list, offset);
        return key === null ? [] : latexCitationOpenItems(list.keys, list.notes, key);
      });
      const before = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
      const quote = latexQuoteBefore(before.replace(/\\([%&_#$])/gu, "$1"));
      return {
        items:
          items.length > 0
            ? items
            : citation.lists.flatMap((list) => latexCitationItems(list.keys, list.notes)),
        quote,
      };
    }
    if (/\n[\t ]*\n/u.test(source.slice(start, offset))) return null;
    start = start === 0 ? -1 : live.lastIndexOf("\\", start - 1);
  }
  return null;
}
