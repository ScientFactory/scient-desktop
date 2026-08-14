/**
 * Guarded single-dollar `$...$` math, recognized at the micromark tokenizer —
 * the only altitude where recognition can be both safe and complete. The
 * tokenizer sees raw source before emphasis fragments a span (`$a*b*c$`
 * arrives whole), markdown's escape construct has already consumed `\$`
 * before this construct ever runs, and a rejected candidate unwinds without
 * disturbing surrounding structure, so links and prices cannot be corrupted
 * the way parser-level `singleDollarTextMath` corrupts them.
 *
 * The construct emits the same `mathText`/`mathTextSequence`/`mathTextData`
 * tokens as `micromark-extension-math`, so `mdast-util-math` (registered by
 * remark-math) converts accepted spans to `inlineMath` nodes with no further
 * wiring. Content is consumed as one contiguous `mathTextData` token — the
 * mdast buffer ignores standalone `space` tokens, and this construct never
 * produces the padding shapes the upstream resolver exists for.
 */

/** micromark character codes: null is EOF, negatives are virtual (line endings, tabs). */
type Code = number | null;

interface TokenizerEffects {
  enter(type: string): unknown;
  exit(type: string): unknown;
  consume(code: Code): void;
}

type State = (code: Code) => State | undefined;

interface TokenizeContext {
  events: Array<[string, { type: string }, unknown]>;
  previous: Code;
}

interface Construct {
  name: string;
  tokenize(this: TokenizeContext, effects: TokenizerEffects, ok: State, nok: State): State;
  previous(this: TokenizeContext, code: Code): boolean;
}

const CODE_EOF = null;
const CODE_SPACE = 32;
const CODE_DOLLAR = 36;
const CODE_BACKSLASH = 92;
const CODE_LEFT_BRACE = 123;

/**
 * Longer candidates are overwhelmingly two unrelated dollars pairing up, not
 * an inline formula; they stay literal. Deliberately tighter than the
 * tree-level `MAX_SCIENT_TEX_LENGTH`, which still bounds `$$` forms.
 */
export const MAX_SCIENT_SINGLE_DOLLAR_TEX_LENGTH = 300;

const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const IDENTIFIER_PATH_PATTERN = /^[A-Z][A-Z0-9_]*[/:.]/;
// `*` is deliberately absent: in spaced prose an asterisk is almost always
// the author's emphasis delimiter, and letting it qualify a span would let
// `*a $b* c$` destroy the emphasis and render "b* c" as a formula.
const SPACED_CONTENT_SIGNAL_PATTERN = /[\\^_{}=+\-<>|]/;
const COLON_SIGNAL_PATTERN = /[\\^_{}=<>]/;
// Every plausible formula ends in an alphanumeric (any script), a closing
// bracket, factorial, prime, or percent. Content ending in a bare binder —
// `src/`, `a=`, `1,`, `h{`, `(pwd)/` — is two unrelated dollars gluing shell
// or code together, never complete TeX.
const CONTENT_END_PATTERN = /[\p{L}\p{N})\]}!'%]$/u;
// A prime attaches to a symbol (`x'`, `f(x)'`); a quote after whitespace is
// shell quoting (`'$FILE' -C '$DEST'` pairs into `FILE' -C '`).
const PRIME_END_PATTERN = /[\p{L}\p{N})\]}]'$/u;
const HTML_TAG_LIKE_PATTERN = /<\/?[a-zA-Z][^<>]*>/;
const INTERPOLATION_SIGNAL_PATTERN = /[\\^_+\-*=<>|]/;
const BARE_BRACKET_GROUP_PATTERN = /^!?\[[^\][]*\]$/;
const DOMAIN_LIKE_PATTERN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+){2,}$/u;
// A TeX backslash starts a control word (two-plus letters: `\alpha`, `\to`)
// or a control symbol (`\%`, `\$`, `\,`). A backslash followed by a single
// alphanumeric — `\n`, `\t`, `\E`, `\1` — is a string escape or regex
// backreference, the signature of `echo -e "$a\n$b"` glue; KaTeX rejects
// those anyway, so such spans could only ever show the literal fallback.
const STRING_ESCAPE_PATTERN = /\\(?![a-zA-Z]{2,})[a-zA-Z0-9]/;
const TEX_CONTROL_WORD_PATTERN = /\\[a-zA-Z]{2,}/;
// A call with a multi-letter or dotted name (`foo(1)`, `el.fadeOut(200)`) is
// code; informal math writes single-letter functions or the classic named
// operators.
const CALL_SHAPE_PATTERN = /^([a-zA-Z][\w$]*(?:\.[\w$]+)*)\(/;
const MATH_FUNCTION_NAMES = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "sinh",
  "cosh",
  "tanh",
  "coth",
  "arcsin",
  "arccos",
  "arctan",
  "log",
  "ln",
  "lg",
  "exp",
  "det",
  "gcd",
  "lcm",
  "max",
  "min",
  "lim",
  "sup",
  "inf",
  "arg",
  "mod",
  "deg",
  "dim",
  "ker",
  "Pr",
]);

/**
 * Closing parens or brackets the span never opened are glued code
 * (`if ($a)$b`, `$el.fadeOut()$next`), never complete TeX. Content that
 * opens with a bracket is exempt so half-open intervals (`[0,1)`) survive.
 */
function hasGluedClosers(content: string): boolean {
  if (content.startsWith("(") || content.startsWith("[")) return false;
  let parens = 0;
  let brackets = 0;
  for (const character of content) {
    if (character === "(") parens += 1;
    else if (character === ")") {
      parens -= 1;
      if (parens < 0) return true;
    } else if (character === "[") brackets += 1;
    else if (character === "]") {
      brackets -= 1;
      if (brackets < 0) return true;
    }
  }
  return parens !== 0 || brackets !== 0;
}

function isDigitCode(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

function isAsciiAlphanumericCode(code: Code): boolean {
  return (
    code !== null &&
    ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122))
  );
}

function isWhitespaceCode(code: Code): boolean {
  return code === null || code < 0 || code === CODE_SPACE;
}

/**
 * Whether an accepted candidate reads as TeX rather than prose or code.
 * Shell identifiers (`$PATH$`) and identifier paths (`$HOME/bin:` between two
 * shell variables) stay text; content must end the way formulas end (an
 * alphanumeric, `)]}`, `!`, `'`, `%`), which rejects the glued-variable class
 * (`$src/$dst`, `$a=$b`, `awk '$1==$NF'`); interpolation-shaped content
 * starting with `(` or `{` needs a TeX operator (`$(a+b)^2$` has one,
 * `$(pwd)$` and `${row}$` do not); spaced prose needs an operator or control
 * sequence; a colon needs a strong TeX signal (`f: X \to Y` has one,
 * `HOME/bin:` does not); markdown structure is never math content — the `](`
 * inline-link and `][` reference-link boundaries, bare reference labels
 * (`[foo]`, but `[0,1]` intervals stay math), footnote references (`[^1]`),
 * and HTML-tag or autolink shapes (`</b>`, `<https://…>`); and bare
 * domain-like content (`www.x.test`) is prose. Compact spans — `$42$`,
 * `$1/2$`, `$f(x)$`, `$a*b*c$` — are math.
 */
export function isPlausibleScientSingleDollarTex(content: string): boolean {
  if (content.length === 0 || content.length > MAX_SCIENT_SINGLE_DOLLAR_TEX_LENGTH) return false;
  if (STRING_ESCAPE_PATTERN.test(content)) return false;
  if (IDENTIFIER_PATTERN.test(content)) return false;
  if (IDENTIFIER_PATH_PATTERN.test(content)) return false;
  if (!CONTENT_END_PATTERN.test(content)) return false;
  if (content.endsWith("'") && !PRIME_END_PATTERN.test(content)) return false;
  // An unescaped trailing % is a TeX comment and always renders wrong.
  if (content.endsWith("%") && !content.endsWith("\\%")) return false;
  if (/\s/.test(content) && !SPACED_CONTENT_SIGNAL_PATTERN.test(content)) return false;
  if (content.includes(":") && !COLON_SIGNAL_PATTERN.test(content)) return false;
  if (content.includes("](") || content.includes("][") || content.includes("[^")) return false;
  if (BARE_BRACKET_GROUP_PATTERN.test(content) && !/[\d\\^_+\-*/=,]/.test(content)) return false;
  if (HTML_TAG_LIKE_PATTERN.test(content)) return false;
  // Dereference arrows (`$x->{key}$y`) and empty-paren calls (`$a.b()$c`)
  // are code glue; TeX writes \to and functions take arguments.
  if (
    (content.includes("->") || content.includes("=>")) &&
    !TEX_CONTROL_WORD_PATTERN.test(content)
  ) {
    return false;
  }
  if (content.includes("()")) return false;
  const call = CALL_SHAPE_PATTERN.exec(content);
  const callName = call?.[1];
  if (
    callName !== undefined &&
    (callName.includes(".") || (callName.length > 1 && !MATH_FUNCTION_NAMES.has(callName)))
  ) {
    return false;
  }
  if (hasGluedClosers(content)) return false;
  // A brace group in TeX always carries a control word (`{a \over b}`); a
  // bare `{` start is interpolation (`${PREFIX:-app}`, `${dir//\//_}`).
  if (content.startsWith("{") && !TEX_CONTROL_WORD_PATTERN.test(content)) return false;
  // A parenthesized span needs a TeX operator, and once it contains spaces a
  // shell flag's `-`/`+` is not enough (`$(date -u)$`, `$(date +%F)$`).
  if (content.startsWith("(")) {
    const signal = /\s/.test(content) ? /[\\^_=]/ : /[\\^_+\-*/=]/;
    if (!signal.test(content)) return false;
  }
  if (DOMAIN_LIKE_PATTERN.test(content) && !INTERPOLATION_SIGNAL_PATTERN.test(content)) {
    return false;
  }
  return true;
}

function scientSingleDollarMathText(): Construct {
  return { name: "scientMathTextSingleDollar", tokenize, previous };

  /**
   * Mirrors `micromark-extension-math`: not after an unescaped dollar. This
   * hook only helps micromark decide whether a position can break text at
   * all — when several constructs share a code, an attempt runs them all
   * regardless of their individual `previous` hooks — so the real Scient
   * guards live at the start of `tokenize`, where they always execute.
   */
  function previous(this: TokenizeContext, code: Code): boolean {
    if (code === CODE_DOLLAR) {
      return this.events[this.events.length - 1]?.[1].type === "characterEscape";
    }
    return true;
  }

  function tokenize(
    this: TokenizeContext,
    effects: TokenizerEffects,
    ok: State,
    nok: State,
  ): State {
    // Both are settled before the attempt starts, so capturing them here
    // avoids aliasing `this` into the state closures.
    const openerPrevious = this.previous;
    const openerPreviousEventType = this.events[this.events.length - 1]?.[1].type;
    let content = "";
    let previousCode: Code = CODE_DOLLAR;
    return start;

    function start(code: Code): State | undefined {
      // The opener must not follow a word character (`file$x$`, `US$5$`) or
      // an unescaped dollar. Characters beyond ASCII stay conservative: a
      // dollar glued to non-ASCII text reads as prose, not an opener.
      if (
        isAsciiAlphanumericCode(openerPrevious) ||
        (openerPrevious !== null && openerPrevious > 127) ||
        (openerPrevious === CODE_DOLLAR && openerPreviousEventType !== "characterEscape")
      ) {
        return nok(code);
      }
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      effects.consume(code);
      effects.exit("mathTextSequence");
      return afterOpener;
    }

    function afterOpener(code: Code): State | undefined {
      // A second dollar belongs to the `$$` construct; a space, line ending,
      // or EOF after the opener means this dollar is prose.
      if (code === CODE_DOLLAR || isWhitespaceCode(code)) {
        return nok(code);
      }
      effects.enter("mathTextData");
      return data(code);
    }

    function data(code: Code): State | undefined {
      if (code === CODE_EOF || code === null || code < 0) {
        // Single-line only: an unclosed span stays literal, which also keeps
        // a streaming half-formula from rendering prematurely.
        return nok(code);
      }
      if (code === CODE_DOLLAR && previousCode !== CODE_BACKSLASH) {
        if (previousCode === CODE_SPACE || !isPlausibleScientSingleDollarTex(content)) {
          return nok(code);
        }
        effects.exit("mathTextData");
        effects.enter("mathTextSequence");
        effects.consume(code);
        effects.exit("mathTextSequence");
        return afterCloser;
      }
      if (content.length >= MAX_SCIENT_SINGLE_DOLLAR_TEX_LENGTH) {
        return nok(code);
      }
      content += code === CODE_SPACE ? " " : String.fromCodePoint(code);
      previousCode = code;
      effects.consume(code);
      return data;
    }

    function afterCloser(code: Code): State | undefined {
      // A digit after the closer is a price range (`$5-$10`); another dollar
      // means this closer was really part of a `$$` sequence; a brace is the
      // next interpolation (`"$dir${file}"`) — real math never abuts `{`.
      if (isDigitCode(code) || code === CODE_DOLLAR || code === CODE_LEFT_BRACE) {
        return nok(code);
      }
      effects.exit("mathText");
      return ok(code);
    }
  }
}

interface UnifiedProcessorLike {
  data(): unknown;
}

/**
 * Registers the construct after remark-math's own (which refuses single
 * dollars), so `$$...$$` keeps its exact upstream behavior and only lone
 * dollars reach the guarded tokenizer. Must appear after `remarkScientMath`
 * in the plugin array.
 */
export function remarkScientSingleDollarMath(this: UnifiedProcessorLike): void {
  // remark-parse reads `micromarkExtensions` from the processor's data; the
  // unified `Data` shape is module-augmented, so it is widened here instead
  // of depending on which augmentations this compilation happens to load.
  // oxlint-disable-next-line oxc/no-this-in-exported-function -- unified invokes plugins with the processor bound as `this`; that is the plugin contract.
  const data = this.data() as { micromarkExtensions?: unknown[] };
  const extensions = (data.micromarkExtensions ??= []);
  extensions.push({ text: { [CODE_DOLLAR]: scientSingleDollarMathText() } });
}
