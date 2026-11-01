export interface RunOutputPiece {
  readonly text: string;
  /** Where this text points in the project. */
  readonly link?: { readonly relativePath: string; readonly line: number };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * `file.c:12:5`, `file.java:12`, `file.rs:12:5`, `file.c(12)`, `File "file.py", line 12`,
 * `at file.pl line 12`, `file.sh: line 12` and `file "file.tcl" line 12`.
 */
const LINE_AFTER_PATH = String.raw`(?:["']?,?:? line (\d+)|:(\d+)(?::\d+)?|\((\d+)\))?`;

/**
 * Splits a program's output so that each place in a project file can be opened, whichever
 * language wrote it. Project paths are shown relative to the project, where they are readable.
 */
export function splitRunOutputLinks(
  text: string,
  place: { readonly cwd: string; readonly relativePath: string },
): ReadonlyArray<RunOutputPiece> {
  const root = place.cwd.replace(/[\\/]+$/u, "");
  const source = [root, ...place.relativePath.split("/")];
  const separators = String.raw`[\\/]`;
  // The file that ran comes first, because its path may hold spaces a general match stops at.
  const pattern = new RegExp(
    String.raw`(?:file://)?(${source.map(escaped).join(separators)}|${escaped(root)}${separators}[^\s:"'()<>]+)${LINE_AFTER_PATH}`,
    "gu",
  );
  const pieces: RunOutputPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const [whole, path, wordLine, colonLine, bracketLine] = match;
    const relativePath = path!.slice(root.length + 1).replaceAll("\\", "/");
    if (match.index > last) pieces.push({ text: text.slice(last, match.index) });
    const suffix = whole.slice(whole.indexOf(path!) + path!.length);
    const line = Number(wordLine ?? colonLine ?? bracketLine);
    pieces.push(
      Number.isSafeInteger(line) && line > 0
        ? { text: `${relativePath}${suffix}`, link: { relativePath, line } }
        : { text: `${relativePath}${suffix}` },
    );
    last = match.index + whole.length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}
