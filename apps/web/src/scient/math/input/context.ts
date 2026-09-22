import type { MathEdit, MathSelection } from "./catalog";
import { isPlausibleScientSingleDollarTex } from "../scientSingleDollarMath";

export type MathInputFormat = "tex" | "latex" | "markdown";
export interface MathRegion {
  readonly from: number;
  readonly to: number;
  readonly display: boolean;
}

export function declaredMathPackages(source: string): readonly string[] {
  const preamble = source.split("\\begin{document}")[0] ?? "";
  const uncommented = preamble.replace(/(?<!\\)%[^\n]*/gu, "");
  return Array.from(
    uncommented.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/gu),
  ).flatMap((match) => match[1]!.split(",").map((name) => name.trim()));
}

/** Bounded lexical context: never reinterpret code, comments, macro definitions,
 * or unmatched delimiters as an editable equation. Rendering is owned by the host. */
export function mathContext(
  source: string,
  selection: MathSelection,
  format: MathInputFormat,
): MathRegion | "prose" | null {
  if (
    selection.from < 0 ||
    selection.to < selection.from ||
    selection.to > source.length ||
    source.length > 1_000_000
  )
    return null;
  if (format === "tex") return { from: 0, to: source.length, display: true };
  if (
    format === "latex" &&
    /\\(?:catcode|def|gdef|edef|xdef|let|futurelet)\b/u.test(source.replace(/(?<!\\)%[^\n]*/gu, ""))
  )
    return null;
  let active: { from: number; close: string; display: boolean } | null = null;
  for (let i = 0; i < source.length;) {
    const startsBeforeSelection = i <= selection.to;
    if (!active && i > selection.to) return "prose";
    let skipTo: number | undefined;
    if (format === "markdown" && (i === 0 || source[i - 1] === "\n")) {
      const line = source.slice(i).match(/^([^\n]*)(?:\n|$)/u)?.[1] ?? "";
      const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (fence) {
        const rest = source.slice(i + line.length + 1);
        const closing = new RegExp(
          `^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[ \\t]*$`,
          "mu",
        ).exec(rest);
        skipTo = closing ? i + line.length + 1 + closing.index + closing[0].length : source.length;
      } else if (/^(?: {4}|\t)/u.test(line)) skipTo = i + line.length;
    }
    if (format === "markdown" && source[i] === "`" && !active) {
      const marker = /^`+/u.exec(source.slice(i))![0];
      const end = source.indexOf(marker, i + marker.length);
      skipTo = end < 0 ? source.length : end + marker.length;
    }
    if (format === "markdown" && source[i] === "<" && !active) {
      const tag =
        /^(?:<!--[\s\S]*?(?:-->|$)|<(?:pre|code|script|style)\b[\s\S]*?<\/(?:pre|code|script|style)>|<[^>]*>)/iu.exec(
          source.slice(i),
        );
      if (tag) skipTo = i + tag[0].length;
    }
    if (format === "markdown" && !active && source.startsWith("](", i)) {
      let depth = 1;
      let end = i + 2;
      for (; end < source.length && depth > 0; end++) {
        if (source[end] === "\\") end++;
        else if (source[end] === "(") depth++;
        else if (source[end] === ")") depth--;
      }
      skipTo = end;
    }
    if (format === "latex" && source[i] === "%")
      skipTo = source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i);
    if (format === "latex" && !active && source.startsWith("\\verb", i)) {
      const verb = /^\\verb\*?([^A-Za-z\s])/u.exec(source.slice(i));
      if (verb) {
        const end = source.indexOf(verb[1]!, i + verb[0].length);
        skipTo = end < 0 ? source.length : end + 1;
      }
    }
    if (skipTo !== undefined && skipTo > i) {
      if (startsBeforeSelection && skipTo > selection.from) return null;
      i = skipTo;
      continue;
    }
    if (active && source.startsWith(active.close, i)) {
      if (
        format === "markdown" &&
        active.close === "$" &&
        source.slice(active.from, i).trim() !== "" &&
        !isPlausibleScientSingleDollarTex(source.slice(active.from, i).trim())
      ) {
        if (selection.from >= active.from && selection.to <= i) return null;
      }
      if (selection.from >= active.from && selection.to <= i)
        return { from: active.from, to: i, display: active.display };
      if (selection.from < i + active.close.length && selection.to >= active.from) return null;
      i += active.close.length;
      active = null;
      continue;
    }
    if (!active) {
      const opener = source.startsWith("\\(", i)
        ? "\\("
        : source.startsWith("\\[", i)
          ? "\\["
          : source.startsWith("$$", i)
            ? "$$"
            : source[i] === "$"
              ? "$"
              : null;
      const env =
        format === "latex"
          ? /^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|displaymath|math)\}/u.exec(
              source.slice(i),
            )
          : null;
      if (env) {
        active = { from: i + env[0].length, close: `\\end{${env[1]}}`, display: env[1] !== "math" };
        i += env[0].length;
        continue;
      }
      if (opener) {
        active = {
          from: i + opener.length,
          close: opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : opener,
          display: opener !== "$" && opener !== "\\(",
        };
        i += opener.length;
        continue;
      }
      if (format === "latex") {
        const opaque = /^\\begin\{(verbatim\*?|lstlisting|minted|tikzpicture)\}/u.exec(
          source.slice(i),
        );
        if (opaque) {
          const end = source.indexOf(`\\end{${opaque[1]}}`, i + opaque[0].length);
          const to = end < 0 ? source.length : end + `\\end{${opaque[1]}}`.length;
          if (i <= selection.to && to > selection.from) return null;
          i = to;
          continue;
        }
      }
    }
    i += source[i] === "\\" ? 2 : 1;
  }
  return active ? null : "prose";
}

export function wrapMathEdit(edit: MathEdit, format: MathInputFormat, display: boolean): MathEdit {
  const opening = display ? (format === "markdown" ? "\n$$\n" : "\\[\n") : "\\(";
  const closing = display ? (format === "markdown" ? "\n$$\n" : "\n\\]") : "\\)";
  return {
    ...edit,
    insert: opening + edit.insert + closing,
    selection: {
      from: edit.selection.from + opening.length,
      to: edit.selection.to + opening.length,
    },
  };
}

/** Literal text arguments and comments keep ordinary typing semantics. */
export function mathLiteralAt(source: string, from: number, caret: number): boolean {
  const groups: boolean[] = [];
  let pendingText = false;
  for (let i = from; i < caret; i += 1) {
    if (source[i] === "%") {
      const end = source.indexOf("\n", i);
      if (end < 0 || end >= caret) return true;
      i = end;
    } else if (source[i] === "\\") {
      const command = /^\\([A-Za-z]+|.)/u.exec(source.slice(i));
      if (command) {
        pendingText =
          /^(?:text|textrm|textsf|texttt|textnormal|textbf|textit|mbox|hbox|operatorname)$/u.test(
            command[1]!,
          );
        i += command[0].length - 1;
      }
    } else if (source[i] === "{") {
      groups.push(pendingText || groups.at(-1) === true);
      pendingText = false;
    } else if (source[i] === "}") {
      groups.pop();
      pendingText = false;
    } else if (!/\s/u.test(source[i]!)) pendingText = false;
  }
  return groups.at(-1) === true;
}
