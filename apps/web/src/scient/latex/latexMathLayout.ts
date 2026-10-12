/** Keep the math body intact when switching between display layouts. */
export function alignedMathBody(tex: string, environment?: string | null): string {
  if (environment === "align" || environment === "align*") return tex;
  const aligned = /^\\begin\{aligned\}([\s\S]*)\\end\{aligned\}$/u.exec(tex.trim());
  if (aligned) return aligned[1]!.trim();
  // Only align at a top-level equals sign, never inside a matrix or argument.
  let depth = 0;
  let environments = 0;
  for (let at = 0; at < tex.length; at++) {
    if (tex[at] === "\\") {
      const command = /^\\(begin|end)\{[^{}]+\}/u.exec(tex.slice(at));
      if (command) {
        environments += command[1] === "begin" ? 1 : -1;
        at += command[0].length - 1;
      } else at++;
    } else if (tex[at] === "{") depth++;
    else if (tex[at] === "}") depth--;
    else if (tex[at] === "=" && depth === 0 && environments === 0) {
      return [tex.slice(0, at) + "&" + tex.slice(at), "{} & {}"].join(" " + String.raw`\\` + "\n");
    }
  }
  return [tex + " & {}", "{} & {}"].join(" " + String.raw`\\` + "\n");
}

export function isAlignedMath(tex: string, environment?: string | null): boolean {
  return (
    environment === "align" ||
    environment === "align*" ||
    /^\\begin\{aligned\}[\s\S]*\\end\{aligned\}$/u.test(tex.trim())
  );
}
