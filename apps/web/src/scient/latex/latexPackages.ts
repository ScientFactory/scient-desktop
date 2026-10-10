/** Package declarations and tool requirements share this source-level inventory. */
import { latexSourceArgument } from "./latexSourceSyntax";

const commandPackages: Readonly<Record<string, readonly string[]>> = {
  color: ["xcolor"],
  textcolor: ["xcolor"],
  colorbox: ["xcolor"],
  fcolorbox: ["xcolor"],
  definecolor: ["xcolor"],
  providecolor: ["xcolor"],
  colorlet: ["xcolor"],
  pagecolor: ["xcolor"],
  rowcolor: ["xcolor", "colortbl"],
  multirow: ["multirow"],
  columncolor: ["xcolor", "colortbl"],
  cellcolor: ["xcolor", "colortbl"],
  arrayrulecolor: ["xcolor", "colortbl"],
  cancel: ["cancel"],
  bcancel: ["cancel"],
  xcancel: ["cancel"],
  cancelto: ["cancel"],
  text: ["amsmath"],
  boldsymbol: ["amsmath"],
  bm: ["bm"],
  dfrac: ["amsmath"],
  tfrac: ["amsmath"],
  binom: ["amsmath"],
  dbinom: ["amsmath"],
  tbinom: ["amsmath"],
  cfrac: ["amsmath"],
  substack: ["amsmath"],
  overset: ["amsmath"],
  underset: ["amsmath"],
  operatorname: ["amsmath"],
  DeclareMathOperator: ["amsmath"],
  tag: ["amsmath"],
  notag: ["amsmath"],
  eqref: ["amsmath"],
  subref: ["subcaption"],
  includegraphics: ["graphicx"],
  rotatebox: ["graphicx"],
  scalebox: ["graphicx"],
  resizebox: ["graphicx"],
  toprule: ["booktabs"],
  midrule: ["booktabs"],
  bottomrule: ["booktabs"],
  cmidrule: ["booktabs"],
  addlinespace: ["booktabs"],
  arraybackslash: ["array"],
  href: ["hyperref"],
  hyperlink: ["hyperref"],
  hyperref: ["hyperref"],
  hypertarget: ["hyperref"],
  autoref: ["hyperref"],
  url: ["url"],
  cref: ["cleveref"],
  Cref: ["cleveref"],
};

const providedPackages: Readonly<Record<string, readonly string[]>> = {
  mathtools: ["amsmath"],
  amssymb: ["amsfonts"],
  "unicode-math": ["amssymb", "amsfonts", "mathrsfs", "dsfont"],
  tabularx: ["array"],
  colortbl: ["array", "color"],
  xcolor: ["color"],
  hyperref: ["url"],
  algorithm: ["float"],
};

// Preserve offsets so declarations can be inserted without rewriting the preamble.
export function latexWithoutComments(source: string): string {
  return source.replace(/\\(?:[A-Za-z]+|[^\r\n])|%[^\r\n]*/gu, (token) =>
    token.startsWith("%") ? " ".repeat(token.length) : token,
  );
}

export function latexCommands(source: string) {
  return [...latexWithoutComments(source).matchAll(/\\([A-Za-z]+|[^\r\n])/gu)];
}

/** Existing commands do not turn an unrelated prose edit into a package edit. */
export function newLatexCommandPackages(
  previous: string,
  next: string,
  documentSource?: string,
): Set<string> {
  const remaining = new Map<string, number>();
  for (const match of latexCommands(previous))
    remaining.set(match[1]!, (remaining.get(match[1]!) ?? 0) + 1);
  const packages = new Set<string>();
  const hasColor = documentSource && latexPackageInventory(documentSource).loaded.has("color");
  for (const match of latexCommands(next)) {
    const command = match[1]!;
    const count = remaining.get(command) ?? 0;
    if (count > 0) remaining.set(command, count - 1);
    else {
      if (hasColor && ["color", "textcolor", "colorbox"].includes(command)) {
        const at = match.index + match[0].length;
        const model = latexSourceArgument(next, at, "[", "]");
        const value = latexSourceArgument(next, model?.end ?? at);
        if (model && value) {
          const spec = model.value.trim();
          const count = spec === "gray" ? 1 : spec === "rgb" ? 3 : spec === "cmyk" ? 4 : 0;
          const parts = value.value.split(",").map((part) => part.trim());
          if (
            count &&
            parts.length === count &&
            parts.every((part) => /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(part) && Number(part) <= 1)
          )
            continue;
        } else if (
          !model &&
          value &&
          /^(?:black|white|red|green|blue|cyan|magenta|yellow)$/u.test(value.value.trim())
        )
          continue;
      }
      commandPackages[command]?.forEach((name) => packages.add(name));
    }
  }
  return packages;
}

/** Locate the real document boundary without scanning or copying its body. */
export function latexPreambleEnd(source: string): number {
  const tokens = /\\([A-Za-z]+|[^\r\n])|[{}%]/gu;
  const document = /(?:\s|%[^\r\n]*(?:\r?\n|$))*\{document\}/uy;
  let depth = 0;
  for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
    if (token[0] === "%") {
      const newline = source.indexOf("\n", tokens.lastIndex);
      if (newline < 0) break;
      tokens.lastIndex = newline + 1;
    } else if (token[0] === "{") depth++;
    else if (token[0] === "}") depth--;
    else if (depth === 0 && token[1] === "begin") {
      document.lastIndex = tokens.lastIndex;
      if (document.test(source)) return token.index;
    }
  }
  return source.length;
}

export function latexPackageInventory(source: string) {
  const clean = latexWithoutComments(source.slice(0, latexPreambleEnd(source)));
  let end = clean.length;
  let directionBoundary: number | null = null;
  const declarations: { name: string; from: number; options: string }[] = [];
  let depth = 0;
  // Consume control symbols as well, so escaped braces and \\usepackage are literal.
  for (const token of clean.matchAll(/\\([A-Za-z]+|[^\r\n])|[{}]/gu)) {
    if (token[0] === "{") depth++;
    else if (token[0] === "}") depth--;
    else if (
      depth === 0 &&
      token[1] === "begin" &&
      /^\s*\{document\}/u.test(clean.slice(token.index + token[0].length))
    ) {
      end = token.index;
      break;
    } else if (
      depth === 0 &&
      ["setdefaultlanguage", "setmainlanguage", "setotherlanguage", "setotherlanguages"].includes(
        token[1]!,
      )
    ) {
      const args = /^\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/u.exec(
        clean.slice(token.index + token[0].length),
      );
      if (args?.[1]?.split(",").some((language) => language.trim() === "hebrew"))
        directionBoundary ??= token.index;
    } else if (depth === 0 && ["usepackage", "RequirePackage"].includes(token[1]!)) {
      const args = /^\s*(?:\[([^\]]*)\]\s*)?\{([^{}]+)\}/u.exec(
        clean.slice(token.index + token[0].length),
      );
      if (args)
        for (const name of args[2]!.split(",").map((value) => value.trim()))
          declarations.push({ name, from: token.index, options: args[1] ?? "" });
    }
  }
  const loaded = new Set(declarations.map(({ name }) => name));
  if (
    declarations.some(
      ({ name, options }) =>
        name === "xcolor" && options.split(",").some((option) => option.trim() === "table"),
    )
  )
    loaded.add("colortbl");
  for (const name of loaded) providedPackages[name]?.forEach((provided) => loaded.add(provided));
  return { preamble: clean.slice(0, end), end, declarations, loaded, directionBoundary };
}

/** Only add missing declarations; keep user options and never remove packages on undo. */
export function ensureLatexPackages(
  source: string,
  required: Iterable<string>,
  eol: string,
): string {
  const { end, declarations, loaded, directionBoundary } = latexPackageInventory(source);
  const wanted = new Set(required);
  const breakable = wanted.delete("tcolorbox-breakable");
  if (breakable) wanted.add("tcolorbox");
  // A newly requested provider also satisfies its dependencies in this same edit.
  for (const name of wanted) providedPackages[name]?.forEach((provided) => loaded.add(provided));
  const missing = [...wanted].filter((name) => !loaded.has(name));
  const needsBreakable =
    breakable &&
    !declarations.some(
      ({ name, options }) =>
        name === "tcolorbox" && /(?:^|,)\s*(?:most|many|breakable)\s*(?:,|$)/u.test(options),
    ) &&
    !/\\tcbuselibrary\s*\{[^{}]*\bbreakable\b[^{}]*\}/u.test(
      latexWithoutComments(source.slice(0, end)),
    );
  if (!missing.length && !needsBreakable) return source;
  const order = [
    "amsmath",
    "amssymb",
    "mathtools",
    "esint",
    "wasysym",
    "xcolor",
    "hyperref",
    "cleveref",
  ];
  missing.sort((a, b) => {
    const priority = (name: string) => (order.includes(name) ? order.indexOf(name) : 5);
    return priority(a) - priority(b);
  });
  // Add dependencies ahead of packages which expect to be loaded late.
  const insertions = new Map<number, string[]>();
  for (const name of missing) {
    const before = declarations.filter(
      (declaration) =>
        (name !== "cleveref" && declaration.name === "cleveref") ||
        (!["hyperref", "cleveref"].includes(name) && declaration.name === "hyperref") ||
        // bidi patches existing packages as Hebrew is enabled. Later insertions
        // must precede that point as well as ordinary dependency ordering.
        ["bidi", "xepersian"].includes(declaration.name) ||
        (declaration.name === "esint" && ["amsmath", "mathtools"].includes(name)),
    );
    const at = Math.min(end, directionBoundary ?? end, ...before.map(({ from }) => from));
    const lines = insertions.get(at) ?? [];
    lines.push(`\\usepackage${name === "wasysym" ? "[nointegrals]" : ""}{${name}}${eol}`);
    insertions.set(at, lines);
  }
  if (needsBreakable) {
    const lines = insertions.get(end) ?? [];
    lines.push(`\\tcbuselibrary{breakable}${eol}`);
    insertions.set(end, lines);
  }
  let next = source;
  for (const [at, lines] of [...insertions].sort(([a], [b]) => b - a)) {
    const boundary = at > 0 && !/[\r\n]/u.test(source[at - 1]!) ? eol : "";
    next = next.slice(0, at) + boundary + lines.join("") + next.slice(at);
  }
  return next;
}

// MathLive's menu includes names that xcolor does not define by default.
const menuColors: Readonly<Record<string, string>> = {
  indigo: "6633CC",
  grey: "A6A6A6",
  "dark-grey": "666666",
  "light-grey": "D4D5D2",
};

export function ensureLatexMenuColors(source: string, content: string, eol: string): string {
  const { preamble, end } = latexPackageInventory(source);
  const clean = latexWithoutComments(content);
  const needed = new Set<string>();
  for (const command of latexCommands(content)) {
    if (!["color", "textcolor", "colorbox", "fcolorbox"].includes(command[1]!)) continue;
    const args = /^\s*\{([^{}]+)\}(?:\s*\{([^{}]+)\})?/u.exec(
      clean.slice(command.index + command[0].length),
    );
    const colors = command[1] === "fcolorbox" ? [args?.[1], args?.[2]] : [args?.[1]];
    for (const color of colors)
      for (const name of color?.replace(/^-/, "").split("!") ?? [])
        if (menuColors[name.trim()]) needed.add(name.trim());
  }
  const declarations = [...needed]
    .filter(
      (name) =>
        !new RegExp(`\\\\(?:definecolor|providecolor|colorlet)\\s*\\{${name}\\}`, "u").test(
          preamble,
        ),
    )
    .map((name) => `\\providecolor{${name}}{HTML}{${menuColors[name]}}${eol}`)
    .join("");
  if (!declarations) return source;
  const boundary = end > 0 && !/[\r\n]/u.test(source[end - 1]!) ? eol : "";
  return source.slice(0, end) + boundary + declarations + source.slice(end);
}
