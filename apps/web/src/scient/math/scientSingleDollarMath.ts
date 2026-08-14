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

/**
 * Longer candidates are overwhelmingly two unrelated dollars pairing up, not
 * an inline formula; they stay literal. Deliberately tighter than the
 * tree-level `MAX_SCIENT_TEX_LENGTH`, which still bounds `$$` forms.
 */
export const MAX_SCIENT_SINGLE_DOLLAR_TEX_LENGTH = 300;

const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const IDENTIFIER_PATH_PATTERN = /^[A-Z][A-Z0-9_]*[/:.]/;
const SPACED_CONTENT_SIGNAL_PATTERN = /[\\^_{}=+\-*<>|]/;
const COLON_SIGNAL_PATTERN = /[\\^_{}=<>]/;

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
 * Whether an accepted candidate reads as TeX rather than prose or shell.
 * Shell identifiers (`$PATH$`) and identifier paths (`$HOME/bin:` between two
 * shell variables) stay text; spaced prose needs an operator or control
 * sequence; a colon needs a strong TeX signal (`f: X \to Y` has one,
 * `HOME/bin:` does not); the `](` sequence is a markdown link boundary and
 * can never be math content. Compact spans — `$42$`, `$1/2$`, `$f(x)$`,
 * `$a*b*c$` — are math.
 */
export function isPlausibleScientSingleDollarTex(content: string): boolean {
  if (content.length === 0 || content.length > MAX_SCIENT_SINGLE_DOLLAR_TEX_LENGTH) return false;
  if (IDENTIFIER_PATTERN.test(content)) return false;
  if (IDENTIFIER_PATH_PATTERN.test(content)) return false;
  if (/\s/.test(content) && !SPACED_CONTENT_SIGNAL_PATTERN.test(content)) return false;
  if (content.includes(":") && !COLON_SIGNAL_PATTERN.test(content)) return false;
  if (content.includes("](")) return false;
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
    const self = this;
    let content = "";
    let previousCode: Code = CODE_DOLLAR;
    return start;

    function start(code: Code): State | undefined {
      // The opener must not follow a word character (`file$x$`, `US$5$`) or
      // an unescaped dollar. Characters beyond ASCII stay conservative: a
      // dollar glued to non-ASCII text reads as prose, not an opener.
      const before = self.previous;
      if (
        isAsciiAlphanumericCode(before) ||
        (before !== null && before > 127) ||
        (before === CODE_DOLLAR &&
          self.events[self.events.length - 1]?.[1].type !== "characterEscape")
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
      // means this closer was really part of a `$$` sequence.
      if (isDigitCode(code) || code === CODE_DOLLAR) {
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
  const data = this.data() as { micromarkExtensions?: unknown[] };
  const extensions = (data.micromarkExtensions ??= []);
  extensions.push({ text: { [CODE_DOLLAR]: scientSingleDollarMathText() } });
}
