import { latexColorCss, latexInlineColor } from "./latexColorBoxes";
import { latexLayoutLength } from "./latexPageLayouts";
import { latexSourceArgument } from "./latexSourceSyntax";

/** Literal frame groups and paragraph boxes retain their exact opening and closing source. */
export function latexBasicBoxOpening(source: string) {
  let at = 0;
  let padding = `${3 / 72.27}in`;
  let borderWidth = `${0.4 / 72.27}in`;
  const grouped = /^\\begingroup\b\s*/u.exec(source);
  if (grouped) {
    at = grouped[0].length;
    for (let count = 0; count < 2; count++) {
      const length = /^\\setlength\s*\{\\(fboxsep|fboxrule)\}\s*\{([^{}]+)\}\s*/u.exec(
        source.slice(at),
      );
      if (!length) break;
      const value = latexLayoutLength(length[2]!);
      if (!value || value.endsWith("%")) return null;
      if (length[1] === "fboxsep") padding = value;
      else borderWidth = value;
      at += length[0].length;
    }
  }
  const frame = latexInlineColor(source, at);
  if (!frame || frame.attrs.command === "textcolor") return null;
  const tail = source.slice(frame.body.end).trim();
  if (tail !== (grouped ? "\\endgroup" : "")) return null;
  let from = frame.body.from,
    to = frame.body.to;
  const trivia = (at: number) =>
    /^(?:\s|%[^\r\n]*(?:\r?\n|$))*/u.exec(source.slice(at, to))![0].length;
  let cursor = from + trivia(from);
  const paragraph = /^\\parbox\b/u.exec(source.slice(cursor, to));
  let width: string | null = null;
  if (paragraph) {
    const dimension = latexSourceArgument(source, cursor + paragraph[0].length);
    const body = dimension && latexSourceArgument(source, dimension.end);
    if (
      !dimension ||
      !body ||
      body.end > to ||
      source.slice(body.end + trivia(body.end), to).trim()
    )
      return null;
    width = /^\\dimexpr\s*\\linewidth\s*-\s*2\s*\\fboxsep\s*-\s*2\s*\\fboxrule\s*\\relax$/u.test(
      dimension.value.trim(),
    )
      ? "100%"
      : latexLayoutLength(dimension.value);
    if (!width) return null;
    from = body.from;
    to = body.to;
  } else if (!grouped) return null;
  const color = frame.attrs.command === "fbox" ? "black" : frame.attrs.color;
  if (!latexColorCss(color)) return null;
  return {
    from,
    to,
    layout: {
      kind: "basicBox",
      command: frame.attrs.command,
      color,
      background: frame.attrs.command === "colorbox" ? color : frame.attrs.background,
      padding,
      borderWidth: frame.attrs.command === "colorbox" ? "0px" : borderWidth,
      width,
    },
  };
}
