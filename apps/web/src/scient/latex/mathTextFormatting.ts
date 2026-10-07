import type { MathfieldElement, Style } from "mathlive";
import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";

export type MathTextFormat = "bold" | "italic" | "monospace";

/** Prose and math use different font commands, including inside a formula's text slots. */
export function mathTextFormatActive(math: MathfieldElement, format: MathTextFormat): boolean {
  if (math.mode === "text") {
    const style: Style =
      format === "bold"
        ? { fontSeries: "b" }
        : format === "italic"
          ? { fontShape: "it" }
          : { fontFamily: "monospace" };
    return math.queryStyle(style) === "all";
  }
  if (format === "monospace") return math.queryStyle({ variant: "monospace" }) === "all";
  return (
    math.queryStyle({ variantStyle: format }) === "all" ||
    math.queryStyle({ variantStyle: "bolditalic" }) === "all"
  );
}

export function toggleMathTextFormat(math: MathfieldElement, format: MathTextFormat): void {
  if (math.mode === "text") {
    math.applyStyle(
      format === "bold"
        ? { fontSeries: "b" }
        : format === "italic"
          ? { fontShape: "it" }
          : { fontFamily: "monospace" },
      { operation: "toggle" },
    );
    return;
  }
  if (format === "monospace") {
    math.applyStyle({ variant: "monospace", variantStyle: "up" }, { operation: "toggle" });
    return;
  }
  const bold =
    format === "bold" ? !mathTextFormatActive(math, "bold") : mathTextFormatActive(math, "bold");
  const italic =
    format === "italic"
      ? !mathTextFormatActive(math, "italic")
      : mathTextFormatActive(math, "italic");
  math.applyStyle({
    variant: "main",
    variantStyle: bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "up",
  });
}

/** MathLive's combined font command needs a portable LaTeX spelling. */
export function mathTextFormattingSource(source: string, customMathbfit = false): string {
  if (customMathbfit || !source.includes("\\mathbfit")) return source;
  for (const command of latexSourceCommands(source).toReversed()) {
    if (command.name !== "mathbfit") continue;
    const body = latexSourceArgument(source, command.to);
    if (body)
      source =
        source.slice(0, command.from) +
        `\\boldsymbol{\\mathit{${body.value}}}` +
        source.slice(body.end);
  }
  return source;
}

/** Retain combined weight/slant when MathLive reparses standard LaTeX font nesting. */
export function mathTextFormattingInput(
  source: string,
  customCommands?: Readonly<Record<string, unknown>>,
): string {
  if (customCommands?.mathbfit || customCommands?.mathit) return source;
  if (!source.includes("\\boldsymbol") && !source.includes("\\bm")) return source;
  for (const command of latexSourceCommands(source).toReversed()) {
    if (command.name !== "boldsymbol" && command.name !== "bm") continue;
    if (customCommands?.[command.name]) continue;
    const body = latexSourceArgument(source, command.to);
    if (!body) continue;
    const inner = /^\s*\\mathit\b/u.exec(body.value);
    const text = inner && latexSourceArgument(body.value, inner[0].length);
    if (text && !body.value.slice(text.end).trim())
      source = source.slice(0, command.from) + `\\mathbfit{${text.value}}` + source.slice(body.end);
  }
  return source;
}
