import { latexSourceArgument } from "./latexSourceSyntax";
import { latexBasicBoxOpening } from "./latexBasicBoxes";

/** A single literal framed paragraph float; all wrapper spelling stays source-owned. */
export function latexFramedFigureOpening(source: string) {
  const opening = /^\\begin\{(figure\*?)\}(?:\[[htbpH!]*\])?\s*(?:\\centering\b\s*)?/u.exec(source);
  if (!opening) return null;
  const from = opening[0].length;
  const frame = /^\\fbox\b/u.exec(source.slice(from));
  const argument = frame && latexSourceArgument(source, from + frame[0].length);
  if (!argument || !latexBasicBoxOpening(source.slice(from, argument.end))) return null;
  let at = argument.end;
  let caption: ReturnType<typeof latexSourceArgument> = null;
  let label: ReturnType<typeof latexSourceArgument> = null;
  while (true) {
    at += /^\s*/u.exec(source.slice(at))![0].length;
    const command = /^\\(caption|label)\b/u.exec(source.slice(at));
    if (!command) break;
    const value = latexSourceArgument(source, at + command[0].length);
    if (!value) return null;
    if (command[1] === "caption") {
      if (caption) return null;
      caption = value;
    } else {
      if (label || !/^[^{}\\%\s]+$/u.test(value.value)) return null;
      label = value;
    }
    at = value.end;
  }
  if (source.slice(at).trim() !== `\\end{${opening[1]}}`) return null;
  return { from, to: argument.end, caption, label, environment: opening[1]! };
}
