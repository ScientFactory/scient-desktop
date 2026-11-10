// LaTeX's `---` and \textemdash are em dashes; this is decoded data, not copy.
const EM_DASH = String.fromCodePoint(0x2014);

const COMBINING_ACCENTS: Readonly<Record<string, string>> = {
  "'": "́",
  "`": "̀",
  "^": "̂",
  '"': "̈",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  u: "̆",
  v: "̌",
  H: "̋",
  c: "̧",
  k: "̨",
  r: "̊",
  d: "̣",
  b: "̱",
  t: "͡",
};

const SYMBOL_COMMANDS: Readonly<Record<string, string>> = {
  ss: "ß",
  SS: "SS",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  aa: "å",
  AA: "Å",
  o: "ø",
  O: "Ø",
  l: "ł",
  L: "Ł",
  i: "ı",
  j: "ȷ",
  dh: "ð",
  DH: "Ð",
  dj: "đ",
  DJ: "Đ",
  th: "þ",
  TH: "Þ",
  ng: "ŋ",
  NG: "Ŋ",
  textendash: "–",
  textemdash: EM_DASH,
  textquoteleft: "‘",
  textquoteright: "’",
  textquotedblleft: "“",
  textquotedblright: "”",
  textquotesingle: "'",
  guillemotleft: "«",
  guillemotright: "»",
  textregistered: "®",
  texttrademark: "™",
  copyright: "©",
  textcopyright: "©",
  textdegree: "°",
  textmu: "µ",
  textperthousand: "‰",
  S: "§",
  P: "¶",
  textsection: "§",
  dag: "†",
  ddag: "‡",
  ldots: "…",
  dots: "…",
  textellipsis: "…",
  euro: "€",
  texteuro: "€",
  pounds: "£",
  textsterling: "£",
  textasciitilde: "~",
  textasciicircum: "^",
  textbackslash: "\\",
  textunderscore: "_",
  textbar: "|",
  textless: "<",
  textgreater: ">",
  textbullet: "•",
  textperiodcentered: "·",
  times: "×",
  pm: "±",
  textpm: "±",
  cdot: "·",
  deg: "°",
  infty: "∞",
  leq: "≤",
  geq: "≥",
  le: "≤",
  ge: "≥",
  neq: "≠",
  approx: "≈",
  sim: "∼",
  rightarrow: "→",
  leftarrow: "←",
  to: "→",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  LaTeX: "LaTeX",
  TeX: "TeX",
  BibTeX: "BibTeX",
  "\\": " ",
  newline: " ",
  par: " ",
  quad: " ",
  qquad: " ",
  ",": " ",
  ";": " ",
  ":": " ",
  " ": " ",
  "/": "",
  "-": "",
  "&": "&",
  "%": "%",
  $: "$",
  "#": "#",
  _: "_",
  "{": "{",
  "}": "}",
  "@": "@",
};

/** Commands whose last braced argument is the visible text; the others' arguments are dropped. */
const IGNORED_ARGUMENT_COMMANDS = new Set(["label", "index", "cite", "ref", "footnote"]);

class LatexReader {
  position = 0;
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  get done(): boolean {
    return this.position >= this.text.length;
  }

  peek(offset = 0): string {
    return this.text[this.position + offset] ?? "";
  }

  skipSpaces(): void {
    while (/\s/u.test(this.peek())) this.position += 1;
  }

  /** Reads a balanced `{...}` group and returns its raw inner text. */
  readGroup(): string {
    let depth = 0;
    const start = this.position + 1;
    while (!this.done) {
      const character = this.peek();
      if (character === "\\") {
        this.position += 2;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const inner = this.text.slice(start, this.position);
          this.position += 1;
          return inner;
        }
      }
      this.position += 1;
    }
    return this.text.slice(start);
  }

  readCommandName(): string {
    // Called after the backslash.
    const first = this.peek();
    if (!/[A-Za-z]/u.test(first)) {
      this.position += 1;
      return first;
    }
    let name = "";
    while (/[A-Za-z]/u.test(this.peek())) {
      name += this.peek();
      this.position += 1;
    }
    return name;
  }
}

function decodeAccentArgument(reader: LatexReader): string {
  reader.skipSpaces();
  if (reader.peek() === "{") return decodeLatex(reader.readGroup());
  if (reader.peek() === "\\") {
    reader.position += 1;
    const name = reader.readCommandName();
    return SYMBOL_COMMANDS[name] ?? name;
  }
  const character = reader.peek();
  reader.position += 1;
  return character;
}

function decodeCommand(reader: LatexReader): string {
  const name = reader.readCommandName();
  const accent = COMBINING_ACCENTS[name];
  if (accent !== undefined) {
    const [head = "", ...rest] = [...decodeAccentArgument(reader)];
    if (!head) return "";
    const dotless = head === "ı" ? "i" : head === "ȷ" ? "j" : head;
    return `${dotless}${accent}${rest.join("")}`.normalize("NFC");
  }
  const symbol = SYMBOL_COMMANDS[name];
  if (symbol !== undefined) {
    // A control word swallows following spaces; `{}` terminates it.
    if (/^[A-Za-z]/u.test(name)) {
      if (reader.peek() === "{" && reader.peek(1) === "}") reader.position += 2;
      else if (/^[A-Za-z]+$/u.test(name) && reader.peek() === " ") reader.position += 1;
    }
    return symbol;
  }
  if (name === "href") {
    reader.skipSpaces();
    if (reader.peek() === "{") reader.readGroup();
    reader.skipSpaces();
    return reader.peek() === "{" ? decodeLatex(reader.readGroup()) : "";
  }
  // Unknown or formatting command (\emph, \textit, \url, \mkbibquote...):
  // keep the text of its argument, drop the markup.
  reader.skipSpaces();
  if (reader.peek() === "[") {
    const close = reader.text.indexOf("]", reader.position);
    if (close > 0) reader.position = close + 1;
  }
  if (reader.peek() === "{") {
    const argument = reader.readGroup();
    return IGNORED_ARGUMENT_COMMANDS.has(name) ? "" : decodeLatex(argument);
  }
  return "";
}

/**
 * Converts BibTeX/LaTeX field text to plain Unicode: accents, escaped
 * specials, ligature dashes and quotes, and formatting commands. Grouping
 * braces (used for case protection) are dropped.
 */
export function decodeLatex(text: string): string {
  const reader = new LatexReader(text);
  let output = "";
  while (!reader.done) {
    const character = reader.peek();
    if (character === "\\") {
      reader.position += 1;
      output += decodeCommand(reader);
      continue;
    }
    if (character === "{") {
      output += decodeLatex(reader.readGroup());
      continue;
    }
    if (character === "}" || character === "$") {
      reader.position += 1;
      continue;
    }
    if (character === "~") {
      output += " ";
      reader.position += 1;
      continue;
    }
    if (text.startsWith("---", reader.position)) {
      output += EM_DASH;
      reader.position += 3;
      continue;
    }
    if (text.startsWith("--", reader.position)) {
      output += "–";
      reader.position += 2;
      continue;
    }
    if (text.startsWith("``", reader.position)) {
      output += "“";
      reader.position += 2;
      continue;
    }
    if (text.startsWith("''", reader.position)) {
      output += "”";
      reader.position += 2;
      continue;
    }
    if (text.startsWith("!`", reader.position)) {
      output += "¡";
      reader.position += 2;
      continue;
    }
    if (text.startsWith("?`", reader.position)) {
      output += "¿";
      reader.position += 2;
      continue;
    }
    output += character;
    reader.position += 1;
  }
  return output;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

const BIBTEX_SPECIALS: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/** Escapes plain text for a braced BibTeX value. Non-ASCII text stays UTF-8. */
export function encodeLatex(text: string): string {
  return text.replace(/[\\{}&%$#_~^]/gu, (character) => BIBTEX_SPECIALS[character] ?? character);
}

/**
 * Escapes a title and protects words whose capitals must survive a style's
 * sentence casing (acronyms, gene names, brand names): `DNA`, `mRNA`, `iPhone`.
 */
export function encodeLatexTitle(text: string): string {
  return text
    .split(/(\s+)/u)
    .map((word) => {
      const escaped = encodeLatex(word);
      return /\p{Lu}/u.test(word.slice(1)) || /^\p{Ll}+\p{Lu}/u.test(word)
        ? `{${escaped}}`
        : escaped;
    })
    .join("");
}
