import { latexLengthInches } from "./latexVisualLayout";
import {
  latexSourceArgument,
  latexSourceCommands,
  latexWithoutComments,
} from "./latexSourceSyntax";

/** Literal graphicx options only. Unknown operations retain the source fallback. */
export function latexGraphicsOptions(source: string) {
  const result = {
    width: "",
    height: "",
    keepAspectRatio: false,
    angle: 0,
    trim: null as readonly number[] | null,
    clip: false,
  };
  for (const token of source.split(",")) {
    const option = token.trim();
    if (!option) continue;
    if (/^keepaspectratio(?:\s*=\s*true)?$/u.test(option)) result.keepAspectRatio = true;
    else if (/^keepaspectratio\s*=\s*false$/u.test(option)) result.keepAspectRatio = false;
    else if (/^clip(?:\s*=\s*true)?$/u.test(option)) result.clip = true;
    else if (/^clip\s*=\s*false$/u.test(option)) result.clip = false;
    else if (/^trim\s*=/u.test(option)) {
      const values = option
        .replace(/^trim\s*=\s*/u, "")
        .replace(/^\{(.*)\}$/u, "$1")
        .trim()
        .split(/\s+/u)
        .map((value) => {
          if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) return Number(value) / 72;
          const match = /^(-?)(.*)$/u.exec(value)!;
          const inches = latexLengthInches(match[2]!);
          return inches === null ? NaN : (match[1] ? -1 : 1) * inches;
        });
      if (
        values.length !== 4 ||
        values.some((value) => !Number.isFinite(value) || Math.abs(value) > 30)
      )
        return null;
      result.trim = values;
    } else {
      const pair = /^(width|height|angle)\s*=\s*(.*?)\s*$/u.exec(option);
      if (!pair) return null;
      if (pair[1] === "angle") {
        if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(pair[2]!)) return null;
        const angle = Number(pair[2]);
        if (Math.abs(angle) > 360) return null;
        result.angle = angle;
      } else {
        if (!latexGraphicsLength(pair[2]!)) return null;
        result[pair[1] as "width" | "height"] = pair[2]!;
      }
    }
  }
  return result;
}

export function latexGraphicsLength(source: string): string | null {
  const relative =
    /^((?:\d+(?:\.\d*)?|\.\d+)?)\s*\\(linewidth|textwidth|columnwidth|textheight)$/u.exec(
      source.trim(),
    );
  if (relative) {
    const factor = Number(relative[1] || "1");
    if (!(factor > 0 && factor <= 2)) return null;
    return relative[2] === "textheight"
      ? `calc(${factor} * var(--scient-latex-text-height, 9in))`
      : `${factor * 100}%`;
  }
  const inches = latexLengthInches(source);
  return inches !== null && inches > 0 && inches <= 30 ? `${inches}in` : null;
}

/** Search paths remain project-relative; resolution and traversal checks belong to the asset consumer. */
export function latexGraphicsPaths(preamble: string): string[] {
  let paths: string[] = [];
  const source = latexWithoutComments(preamble);
  for (const command of latexSourceCommands(source)) {
    if (command.name !== "graphicspath" || command.depth !== 0) continue;
    const argument = latexSourceArgument(source, command.to);
    if (!argument) continue;
    const next: string[] = [];
    let at = 0;
    while (at < argument.value.length) {
      if (!argument.value.slice(at).trim()) break;
      const path = latexSourceArgument(argument.value, at);
      if (!path || /[\\{}%#$]/u.test(path.value)) break;
      next.push(path.value);
      at = path.end;
    }
    if (!argument.value.slice(at).trim()) paths = next;
  }
  return paths;
}
