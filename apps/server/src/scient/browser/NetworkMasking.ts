/**
 * What `preview_network` shows of a request. Guaranteed: every value Scient knows is secret for
 * the request is hidden however it is written. Best effort: values named like secrets are hidden
 * by parsing each format, and a format Scient cannot parse is left out. All work is linear.
 */
import { characterEntities } from "character-entities";

/** Values Scient knows are secret for one request, hidden wherever they appear. */
export interface MaskContext {
  readonly secrets: ReadonlyArray<string>;
  /** The request's own address, to resolve relative URLs. */
  readonly base?: string | undefined;
}

/** A body with its secrets hidden, or why it is left out. */
export type CheckedBody =
  | { readonly text: string }
  | { readonly leftOut: "unparsed" | "too-deep" | "too-costly" };

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$/iu;
const URL_HEADER = /^(location|content-location|referer|origin|refresh|link)$/iu;
/** Words that make a key, attribute, element or field name a secret's. */
const SECRET_NAME =
  /(token|secret|passw|pwd|pass_?code|session|sess_?id|sesskey|csrf|xsrf|auth|api[-_]?key|apikey|signature|bearer|cookie|nonce|otp|code_verifier|credential|private[-_]?key)/iu;
const SECRET_VALUE =
  /^(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/u;
/** Attributes that only name or style things; never hidden for their own name. */
const PLAIN_ATTRIBUTES = new Set([
  "name",
  "id",
  "class",
  "for",
  "type",
  "role",
  "autocomplete",
  "inputmode",
  "placeholder",
  "title",
  "style",
  "lang",
]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data"]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
/** Elements whose content is text up to their end tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Known values of fewer characters are not hidden. */
const MIN_KNOWN = 4;
/** A known value cut off at the end of a shortened text is hidden once this much of it shows. */
const MIN_CUT_SHOWN = 3;
/** Elements named like secrets nested deeper than this leave the body out. */
const MAX_SECRET_ELEMENTS = 64;
/** JSON nested deeper than this is not walked. */
const MAX_JSON_DEPTH = 128;
const MAX_MULTIPART_DEPTH = 3;
const MAX_URL_CHARS = 2048;

const hide = (value: string) => `<hidden ${value.length} chars>`;

const isSecretName = (name: string) => SECRET_NAME.test(name);

const maskValue = (name: string, value: string) =>
  isSecretName(name) || SECRET_VALUE.test(value.trim()) ? hide(value) : value;

const isDigit = (code: number) => code >= 48 && code <= 57;
const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isAlnum = (code: number) => isDigit(code) || isLetter(code);
const isSpace = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
const hexValue = (code: number) =>
  isDigit(code)
    ? code - 48
    : code >= 65 && code <= 70
      ? code - 55
      : code >= 97 && code <= 102
        ? code - 87
        : -1;
const codesOf = (chars: string) => new Set(Array.from(chars, (char) => char.charCodeAt(0)));

// Known values. Each one is searched for in five written forms, each read left to right by one
// Aho-Corasick automaton, so the work is linear in the text whatever the values are: raw (with
// base64 and base64url), percent-encoded, form-encoded, JSON- or JavaScript-escaped, and as
// HTML character references.

/** Named references browsers also read without their semicolon (the HTML legacy list). */
const LEGACY_REFERENCES = new Set([
  "AElig",
  "AMP",
  "Aacute",
  "Acirc",
  "Agrave",
  "Aring",
  "Atilde",
  "Auml",
  "COPY",
  "Ccedil",
  "ETH",
  "Eacute",
  "Ecirc",
  "Egrave",
  "Euml",
  "GT",
  "Iacute",
  "Icirc",
  "Igrave",
  "Iuml",
  "LT",
  "Ntilde",
  "Oacute",
  "Ocirc",
  "Ograve",
  "Oslash",
  "Otilde",
  "Ouml",
  "QUOT",
  "REG",
  "THORN",
  "Uacute",
  "Ucirc",
  "Ugrave",
  "Uuml",
  "Yacute",
  "aacute",
  "acirc",
  "acute",
  "aelig",
  "agrave",
  "amp",
  "aring",
  "atilde",
  "auml",
  "brvbar",
  "ccedil",
  "cedil",
  "cent",
  "copy",
  "curren",
  "deg",
  "divide",
  "eacute",
  "ecirc",
  "egrave",
  "eth",
  "euml",
  "frac12",
  "frac14",
  "frac34",
  "gt",
  "iacute",
  "icirc",
  "iexcl",
  "igrave",
  "iquest",
  "iuml",
  "laquo",
  "lt",
  "macr",
  "micro",
  "middot",
  "nbsp",
  "not",
  "ntilde",
  "oacute",
  "ocirc",
  "ograve",
  "ordf",
  "ordm",
  "oslash",
  "otilde",
  "ouml",
  "para",
  "plusmn",
  "pound",
  "quot",
  "raquo",
  "reg",
  "sect",
  "shy",
  "sup1",
  "sup2",
  "sup3",
  "szlig",
  "thorn",
  "times",
  "uacute",
  "ucirc",
  "ugrave",
  "uml",
  "uuml",
  "yacute",
  "yen",
  "yuml",
]);
/** The longest named reference, `CounterClockwiseContourIntegral`. */
const MAX_REFERENCE_NAME = 31;
const SHORT_ESCAPES = new Map<number, number>([
  [34, 34],
  [39, 39],
  [92, 92],
  [47, 47],
  [98, 8],
  [102, 12],
  [110, 10],
  [114, 13],
  [116, 9],
]);

/** One written character: what it stands for and where it ends (-1 when none starts here). */
interface Unit {
  readonly text: string;
  readonly end: number;
}

const NO_UNIT: Unit = { text: "", end: -1 };

const pointUnit = (point: number, end: number): Unit =>
  point > 0x10ffff ? NO_UNIT : { text: String.fromCodePoint(point), end };

const hexRun = (text: string, from: number, max: number) => {
  let value = 0;
  let at = from;
  while (at < text.length && at - from < max) {
    const digit = hexValue(text.charCodeAt(at));
    if (digit < 0) break;
    value = value * 16 + digit;
    at += 1;
  }
  return { value, end: at, digits: at - from };
};

/** An HTML character reference at `at`: decimal or hex with any zeros, or any named one. */
const referenceAt = (text: string, at: number): Unit => {
  if (text.charCodeAt(at + 1) === 35) {
    let p = at + 2;
    const hex = text.charCodeAt(p) === 120 || text.charCodeAt(p) === 88;
    if (hex) p += 1;
    const start = p;
    let value = 0;
    while (p < text.length) {
      const code = text.charCodeAt(p);
      const digit = hex ? hexValue(code) : isDigit(code) ? code - 48 : -1;
      if (digit < 0) break;
      value = Math.min(value * (hex ? 16 : 10) + digit, 0x110000);
      p += 1;
    }
    if (p === start) return NO_UNIT;
    return pointUnit(value, text.charCodeAt(p) === 59 ? p + 1 : p);
  }
  let p = at + 1;
  while (p < text.length && p - at <= MAX_REFERENCE_NAME && isAlnum(text.charCodeAt(p))) p += 1;
  const name = text.slice(at + 1, p);
  if (text.charCodeAt(p) === 59 && Object.hasOwn(characterEntities, name))
    return { text: characterEntities[name]!, end: p + 1 };
  for (let length = name.length; length >= 2; length -= 1) {
    const legacy = name.slice(0, length);
    if (LEGACY_REFERENCES.has(legacy))
      return { text: characterEntities[legacy]!, end: at + 1 + length };
  }
  return NO_UNIT;
};

const percentByte = (text: string, at: number) => {
  if (text.charCodeAt(at) !== 37) return -1;
  const high = hexValue(text.charCodeAt(at + 1));
  const low = hexValue(text.charCodeAt(at + 2));
  return high < 0 || low < 0 ? -1 : high * 16 + low;
};

/** A percent-encoded UTF-8 character at `at`. */
const percentAt = (text: string, at: number): Unit => {
  const lead = percentByte(text, at);
  if (lead < 0) return NO_UNIT;
  if (lead < 0x80) return pointUnit(lead, at + 3);
  const count = lead >= 0xf0 && lead < 0xf8 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : -1;
  if (count < 0) return NO_UNIT;
  let point = lead & (0x3f >> count);
  for (let index = 1; index <= count; index += 1) {
    const next = percentByte(text, at + index * 3);
    if (next < 0x80 || next > 0xbf) return NO_UNIT;
    point = point * 64 + (next & 0x3f);
  }
  return pointUnit(point, at + (count + 1) * 3);
};

/** A JSON or JavaScript escape at `at`: `\uXXXX`, `\u{X}`, `\xXX` or a short one. */
const escapeAt = (text: string, at: number): Unit => {
  const kind = text.charCodeAt(at + 1);
  if (kind === 117) {
    if (text.charCodeAt(at + 2) === 123) {
      const run = hexRun(text, at + 3, 6);
      return run.digits > 0 && text.charCodeAt(run.end) === 125
        ? pointUnit(run.value, run.end + 1)
        : NO_UNIT;
    }
    // A surrogate pair is two escapes, read as two code units.
    const unit = hexRun(text, at + 2, 4);
    return unit.digits === 4 ? { text: String.fromCharCode(unit.value), end: unit.end } : NO_UNIT;
  }
  if (kind === 120) {
    const run = hexRun(text, at + 2, 2);
    return run.digits === 2 ? pointUnit(run.value, run.end) : NO_UNIT;
  }
  const short = SHORT_ESCAPES.get(kind);
  return short === undefined ? NO_UNIT : { text: String.fromCharCode(short), end: at + 2 };
};

/** How one written form reads the text: which character starts an encoding, and how. */
interface Reading {
  readonly starts: ReadonlySet<number>;
  readonly read: (text: string, at: number) => Unit;
}

const READINGS: ReadonlyArray<Reading> = [
  { starts: codesOf("%"), read: percentAt },
  {
    starts: codesOf("%+"),
    read: (text, at) =>
      text.charCodeAt(at) === 43 ? { text: " ", end: at + 1 } : percentAt(text, at),
  },
  { starts: codesOf("\\"), read: escapeAt },
  { starts: codesOf("&"), read: referenceAt },
];

/** A dictionary automaton over UTF-16 code units, built once per set of known values. */
interface Automaton {
  readonly next: ReadonlyArray<Map<number, number>>;
  readonly fail: Int32Array;
  readonly depth: Int32Array;
  /** The length of the longest pattern that ends in this state, or 0. */
  readonly match: Int32Array;
  /** The hidden value's length shown for that pattern. */
  readonly shown: Int32Array;
  readonly longest: number;
}

const buildAutomaton = (
  patterns: ReadonlyArray<{ readonly text: string; readonly shown: number }>,
): Automaton => {
  const next: Array<Map<number, number>> = [new Map()];
  const depths = [0];
  const ends = [0];
  let longest = 0;
  for (const pattern of patterns) {
    let state = 0;
    for (let index = 0; index < pattern.text.length; index += 1) {
      const code = pattern.text.charCodeAt(index);
      let child = next[state]!.get(code);
      if (child === undefined) {
        child = next.length;
        next.push(new Map());
        depths.push(depths[state]! + 1);
        ends.push(0);
        next[state]!.set(code, child);
      }
      state = child;
    }
    ends[state] = Math.max(ends[state]!, pattern.shown);
    longest = Math.max(longest, pattern.text.length);
  }
  const fail = new Int32Array(next.length);
  const match = new Int32Array(next.length);
  const shown = new Int32Array(next.length);
  const queue = [...next[0]!.values()];
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head]!;
    const ownEnd = ends[state]!;
    match[state] = ownEnd > 0 ? depths[state]! : match[fail[state]!]!;
    shown[state] = ownEnd > 0 ? ownEnd : shown[fail[state]!]!;
    for (const [code, child] of next[state]!) {
      let back = fail[state]!;
      while (back !== 0 && !next[back]!.has(code)) back = fail[back]!;
      fail[child] = next[back]!.get(code) ?? 0;
      queue.push(child);
    }
  }
  return { next, fail, depth: Int32Array.from(depths), match, shown, longest };
};

/** Character comparisons one masking call may make before it gives up. */
const KNOWN_WORK_BUDGET = 32 * 1024 * 1024;

class TooCostly {
  readonly reason = "too-costly";
}

/**
 * Feeds the text through one automaton as one reading writes it, collecting the spans
 * (start, end, shown length) where a known value is written.
 */
const scan = (
  text: string,
  automaton: Automaton,
  reading: Reading | undefined,
  cut: boolean,
  spans: number[],
  work: { left: number },
) => {
  const size = automaton.longest + 1;
  const starts = new Int32Array(size);
  let state = 0;
  let fed = 0;
  let at = 0;
  const feed = (code: number, start: number, end: number) => {
    let steps = 1;
    while (state !== 0 && !automaton.next[state]!.has(code)) {
      state = automaton.fail[state]!;
      steps += 1;
    }
    work.left -= steps;
    if (work.left < 0) throw new TooCostly();
    state = automaton.next[state]!.get(code) ?? 0;
    starts[fed % size] = start;
    fed += 1;
    const length = automaton.match[state]!;
    if (length > 0) spans.push(starts[(fed - length) % size]!, end, automaton.shown[state]!);
  };
  while (at < text.length) {
    const code = text.charCodeAt(at);
    const unit = reading?.starts.has(code) === true ? reading.read(text, at) : NO_UNIT;
    if (unit.end === -1) {
      feed(code, at, at + 1);
      at += 1;
      continue;
    }
    for (let index = 0; index < unit.text.length; index += 1)
      feed(unit.text.charCodeAt(index), at, unit.end);
    at = unit.end;
  }
  if (!cut) return;
  const depth = automaton.depth[state]!;
  if (depth >= MIN_CUT_SHOWN) spans.push(starts[(fed - depth) % size]!, text.length, depth);
};

/** The text with every span hidden; overlapping spans are hidden as one. */
const hideSpans = (text: string, spans: number[]) => {
  if (spans.length === 0) return text;
  const order = Array.from({ length: spans.length / 3 }, (_, index) => index * 3).sort(
    (a, b) => spans[a]! - spans[b]! || spans[b + 1]! - spans[a + 1]!,
  );
  const out: string[] = [];
  let last = 0;
  let index = 0;
  while (index < order.length) {
    const first = order[index]!;
    const start = spans[first]!;
    let end = spans[first + 1]!;
    let shown = spans[first + 2]!;
    index += 1;
    while (index < order.length && spans[order[index]!]! < end) {
      const other = order[index]!;
      end = Math.max(end, spans[other + 1]!);
      shown = Math.max(shown, spans[other + 2]!);
      index += 1;
    }
    out.push(text.slice(last, start), `<hidden ${shown} chars>`);
    last = end;
  }
  out.push(text.slice(last));
  return out.join("");
};

/**
 * Base64 and base64url of the value: on its own (with and without padding) and inside longer
 * data at each of the three byte alignments, without the characters it shares with its
 * neighbours.
 */
const base64Forms = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  const forms = new Set<string>();
  const add = (form: string) => {
    if (form.length === 0) return;
    forms.add(form);
    forms.add(form.replaceAll("+", "-").replaceAll("/", "_"));
  };
  const whole = bytes.toString("base64");
  add(whole);
  add(whole.replace(/=+$/u, ""));
  for (let shift = 0; shift < 3; shift += 1) {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64");
    add(encoded.slice(Math.ceil((8 * shift) / 6), Math.floor((8 * (shift + bytes.length)) / 6)));
  }
  return [...forms];
};

/** Hides known values, or says the text is too costly to check (`undefined`). */
export type KnownMask = (text: string, cut?: boolean) => string | undefined;

/**
 * Hides every known value of 4 or more characters, raw, percent- or form-encoded, JSON-escaped,
 * as HTML references, or as base64 at any alignment, by searching for those forms (the text is
 * never decoded). Shorter values would garble pages and protect nothing. `cut` marks a shortened
 * text, so a value cut off at its end is hidden too.
 */
export const knownMasker = (
  secrets: ReadonlyArray<string>,
  options: { readonly workBudget?: number } = {},
): KnownMask => {
  const values = [...new Set(secrets)].filter((secret) => Array.from(secret).length >= MIN_KNOWN);
  if (values.length === 0) return (text) => text;
  const written = buildAutomaton(values.map((value) => ({ text: value, shown: value.length })));
  const raw = buildAutomaton(
    values.flatMap((value) => [
      { text: value, shown: value.length },
      ...base64Forms(value).map((form) => ({ text: form, shown: value.length })),
    ]),
  );
  return (text, cut = false) => {
    const spans: number[] = [];
    const work = { left: options.workBudget ?? KNOWN_WORK_BUDGET };
    try {
      scan(text, raw, undefined, cut, spans, work);
      for (const reading of READINGS) scan(text, written, reading, cut, spans, work);
    } catch (error) {
      if (error instanceof TooCostly) return undefined;
      throw error;
    }
    return hideSpans(text, spans);
  };
};

/** Every known secret in `text` hidden; a text too costly to check is hidden whole. */
export const maskKnown = (text: string, context: MaskContext | undefined) =>
  context === undefined ? text : (knownMasker(context.secrets)(text) ?? hide(text));

// Best effort, by name, for values Scient does not know.

/** The parameters with secret values hidden, in order and with repeated names kept; or undefined. */
const maskParams = (params: URLSearchParams) => {
  let changed = false;
  const masked = new URLSearchParams();
  for (const [name, value] of params) {
    const shown = maskValue(name, value);
    if (shown !== value) changed = true;
    masked.append(name, shown);
  }
  return changed ? masked.toString() : undefined;
};

const maskParsedUrl = (url: URL) => {
  url.username = "";
  url.password = "";
  const search = maskParams(url.searchParams);
  if (search !== undefined) url.search = search;
  if (url.hash.length > 1) {
    const fragment = maskParams(new URLSearchParams(url.hash.slice(1)));
    if (fragment !== undefined) url.hash = fragment;
  }
  return url.toString();
};

/** Query and fragment values named like secrets, or that look like tokens, are hidden. */
export const maskUrl = (raw: string) => {
  const kept = raw.slice(0, 4 * MAX_URL_CHARS);
  if (!URL.canParse(kept)) return kept.slice(0, MAX_URL_CHARS);
  return maskParsedUrl(new URL(kept)).slice(0, MAX_URL_CHARS);
};

const SAFE_SCHEME = /^(javascript|data|mailto|tel):/iu;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * An absolute or relative URL with its secrets hidden; a relative one is resolved against the
 * request, masked, and written back as relative. Unchanged URLs keep their exact spelling.
 */
const maskUrlLike = (value: string, base: string | undefined) => {
  const trimmed = value.trim();
  if (trimmed === "" || SAFE_SCHEME.test(trimmed)) return value;
  const absolute = ABSOLUTE.test(trimmed) || trimmed.startsWith("//");
  const origin = base ?? "https://scient.invalid/";
  if (!URL.canParse(trimmed, origin)) return value;
  const resolved = new URL(trimmed, origin);
  const plain = resolved.toString();
  const masked = new URL(maskParsedUrl(new URL(plain)));
  if (masked.toString() === plain && !resolved.username && !resolved.password) return value;
  if (absolute && !trimmed.startsWith("//")) return masked.toString();
  // Keep what was written before the query, and give back only the masked query and fragment.
  let cut = 0;
  while (cut < trimmed.length && trimmed[cut] !== "?" && trimmed[cut] !== "#") cut += 1;
  return `${trimmed.slice(0, cut)}${masked.search}${masked.hash}`;
};

/** The rest of a `url=` value, as in meta refresh, masked as a URL. */
const maskRefresh = (value: string, base: string | undefined) => {
  const at = value.toLowerCase().indexOf("url=");
  if (at === -1) return value;
  return `${value.slice(0, at + 4)}${maskUrlLike(value.slice(at + 4), base)}`;
};

const isKeyChar = (code: number) =>
  isAlnum(code) || code === 95 || code === 46 || code === 36 || code === 45;
const isTokenChar = (code: number) =>
  isAlnum(code) || code === 43 || code === 47 || code === 95 || code === 45;
const isJwtChar = (code: number) => isAlnum(code) || code === 95 || code === 45;
const URL_STOP = codesOf(" \t\n\r\f\"'<>`,;");
const VALUE_STOP = codesOf(" \t\n\r\f&;,\"'<>(){}");

const isLongToken = (token: string) => {
  let body = token.length;
  while (body > 0 && token.charCodeAt(body - 1) === 61) body -= 1;
  if (token.length - body > 2) return false;
  let hex = body === token.length;
  for (let index = 0; index < body; index += 1) {
    const code = token.charCodeAt(index);
    if (!isTokenChar(code)) return false;
    if (hexValue(code) < 0) hex = false;
  }
  return body >= 40 || (hex && body >= 32);
};

/**
 * Plain text, scripts and config in one linear pass: `"key": "value"`, `key = 'value'`,
 * `key=value` and `key: value` pairs named like secrets, absolute URLs, JWTs and long quoted
 * tokens.
 */
const maskText = (text: string): string => {
  const out: string[] = [];
  const length = text.length;
  let last = 0;
  const hideSpan = (from: number, to: number) => {
    out.push(text.slice(last, from), hide(text.slice(from, to)));
    last = to;
  };
  const skipBlanks = (from: number) => {
    let at = from;
    while (at < length && (text.charCodeAt(at) === 32 || text.charCodeAt(at) === 9)) at += 1;
    return at;
  };
  /** After a key: `:` or `=` between optional blanks, giving where the value starts; or -1. */
  const separatorEnd = (from: number) => {
    const at = skipBlanks(from);
    const code = text.charCodeAt(at);
    return code === 58 || code === 61 ? skipBlanks(at + 1) : -1;
  };
  /** A pair whose key is named like a secret has its value hidden; returns where to go on. */
  const pair = (key: string, after: number, valueStart: number) => {
    if (!isSecretName(key)) return after;
    const quote = text.charCodeAt(valueStart);
    if (quote === 34 || quote === 39) {
      let at = valueStart + 1;
      while (at < length) {
        const code = text.charCodeAt(at);
        if (code === quote || code === 10) break;
        at += code === 92 ? 2 : 1;
      }
      if (at < length && text.charCodeAt(at) === quote && at > valueStart + 1) {
        hideSpan(valueStart + 1, at);
        return at + 1;
      }
      return after;
    }
    let end = valueStart;
    while (end < length && !VALUE_STOP.has(text.charCodeAt(end))) end += 1;
    if (end === valueStart || text.startsWith("<hidden", valueStart)) return after;
    hideSpan(valueStart, end);
    return end;
  };
  const segmentEnd = (from: number) => {
    let at = from;
    while (at < length && isJwtChar(text.charCodeAt(at))) at += 1;
    return at;
  };
  /** JWTs inside one run of key characters; a failed start rules out the rest of its segment. */
  const hideJwts = (from: number, to: number) => {
    let at = text.indexOf("eyJ", from);
    while (at !== -1 && at < to) {
      const first = segmentEnd(at);
      let next = first;
      if (first - at >= 11 && text.charCodeAt(first) === 46) {
        const second = segmentEnd(first + 1);
        if (second - first - 1 >= 8 && text.charCodeAt(second) === 46) {
          next = segmentEnd(second + 1);
          hideSpan(at, next);
        }
      }
      at = text.indexOf("eyJ", Math.max(next, at + 1));
    }
  };
  let at = 0;
  while (at < length) {
    const code = text.charCodeAt(at);
    if (code === 104 && (text.startsWith("http://", at) || text.startsWith("https://", at))) {
      let end = at;
      while (end < length && !URL_STOP.has(text.charCodeAt(end))) end += 1;
      const url = text.slice(at, end);
      const masked = maskUrlLike(url, undefined);
      if (masked !== url) {
        out.push(text.slice(last, at), masked);
        last = end;
      }
      at = end;
      continue;
    }
    if (code === 34 || code === 39) {
      let keyEnd = at + 1;
      while (keyEnd < length && isKeyChar(text.charCodeAt(keyEnd))) keyEnd += 1;
      if (keyEnd > at + 1 && text.charCodeAt(keyEnd) === code) {
        const valueStart = separatorEnd(keyEnd + 1);
        if (valueStart !== -1) {
          at = pair(text.slice(at + 1, keyEnd), keyEnd + 1, valueStart);
          continue;
        }
      }
      let tokenEnd = at + 1;
      while (tokenEnd < length && isTokenChar(text.charCodeAt(tokenEnd))) tokenEnd += 1;
      let padding = 0;
      while (padding < 3 && text.charCodeAt(tokenEnd) === 61) {
        tokenEnd += 1;
        padding += 1;
      }
      if (text.charCodeAt(tokenEnd) === code && isLongToken(text.slice(at + 1, tokenEnd))) {
        hideSpan(at + 1, tokenEnd);
        at = tokenEnd + 1;
        continue;
      }
      at += 1;
      continue;
    }
    if (isKeyChar(code) && (at === 0 || !isKeyChar(text.charCodeAt(at - 1)))) {
      let keyEnd = at;
      while (keyEnd < length && isKeyChar(text.charCodeAt(keyEnd))) keyEnd += 1;
      const valueStart = separatorEnd(keyEnd);
      if (valueStart !== -1) {
        at = pair(text.slice(at, keyEnd), keyEnd, valueStart);
        continue;
      }
      hideJwts(at, keyEnd);
      at = keyEnd;
      continue;
    }
    at += 1;
  }
  if (last === 0) return text;
  out.push(text.slice(last));
  return out.join("");
};

/** The deepest nesting of a JSON text, counted in one pass. */
const jsonDepth = (text: string) => {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (inString) {
      if (code === 92) at += 1;
      else if (code === 34) inString = false;
    } else if (code === 34) inString = true;
    else if (code === 91 || code === 123) deepest = Math.max(deepest, ++depth);
    else if (code === 93 || code === 125) depth -= 1;
  }
  return deepest;
};

const firstNonBlank = (text: string) => {
  let at = 0;
  while (at < text.length && isSpace(text.charCodeAt(at))) at += 1;
  return text.charCodeAt(at);
};

const looksLikeJson = (text: string) => {
  const code = firstNonBlank(text);
  return code === 123 || code === 91;
};

/** JSON parsed and masked; `undefined` if it does not parse or nests too deeply. */
const maskJsonText = (text: string, nested: boolean): string | undefined => {
  if (jsonDepth(text) > MAX_JSON_DEPTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return JSON.stringify(maskJson(parsed, "", nested), null, nested ? undefined : 1);
};

/** JSON written inside a string, masked once; the string stays as written if nothing changed. */
const maskInnerJson = (value: string) => {
  const masked = maskJsonText(value, true);
  if (masked === undefined) return undefined;
  return JSON.stringify(JSON.parse(value)) === masked ? value : masked;
};

/** JSON values named like secrets hidden; JSON written inside a string is masked one level. */
const maskJson = (value: unknown, key: string, nested: boolean): unknown => {
  if (typeof value === "string") {
    if (isSecretName(key) || SECRET_VALUE.test(value.trim())) return hide(value);
    if (!nested && looksLikeJson(value)) {
      const inner = maskInnerJson(value);
      if (inner !== undefined) return inner;
    }
    return maskText(value);
  }
  if (typeof value === "number" && isSecretName(key)) return hide(String(value));
  if (Array.isArray(value)) return value.map((item) => maskJson(item, key, nested));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, maskJson(item, name, nested)]),
    );
  return value;
};

/** HTML character references in an attribute value, decoded to read the JSON inside it. */
const decodeReferences = (value: string) => {
  if (!value.includes("&")) return value;
  const out: string[] = [];
  let last = 0;
  let at = value.indexOf("&");
  while (at !== -1) {
    const unit = referenceAt(value, at);
    if (unit.end !== -1) {
      out.push(value.slice(last, at), unit.text);
      last = unit.end;
    }
    at = value.indexOf("&", Math.max(last, at + 1));
  }
  out.push(value.slice(last));
  return out.join("");
};

const encodeReferences = (value: string, quote: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(quote, quote === "'" ? "&#39;" : "&quot;");

/** A `data-` attribute holding JSON, masked one level deep and written back. */
const maskDataJson = (value: string, quote: string) => {
  const decoded = decodeReferences(value);
  if (!looksLikeJson(decoded)) return value;
  const masked = maskInnerJson(decoded);
  return masked === undefined || masked === decoded ? value : encodeReferences(masked, quote);
};

/** Each address in a `srcset` list masked, keeping its descriptor. */
const maskSrcset = (value: string, base: string | undefined) =>
  value
    .split(",")
    .map((candidate) => {
      let start = 0;
      while (start < candidate.length && isSpace(candidate.charCodeAt(start))) start += 1;
      let end = start;
      while (end < candidate.length && !isSpace(candidate.charCodeAt(end))) end += 1;
      const url = candidate.slice(start, end);
      const masked = maskUrlLike(url, base);
      return masked === url
        ? candidate
        : `${candidate.slice(0, start)}${masked}${candidate.slice(end)}`;
    })
    .join(",");

interface Attribute {
  readonly name: string;
  readonly value: string | undefined;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quote: string;
}

const NAME_STOP = codesOf("\"'<>/=");
const UNQUOTED_STOP = codesOf("\"'=<>`");

/** The attributes of a start tag between `from` and `to`, read in one pass. */
const attributesOf = (tag: string, from: number, to: number): ReadonlyArray<Attribute> => {
  const attributes: Attribute[] = [];
  let at = from;
  while (at < to) {
    const code = tag.charCodeAt(at);
    if (isSpace(code) || code === 47) {
      at += 1;
      continue;
    }
    const start = at;
    while (at < to && !isSpace(tag.charCodeAt(at)) && !NAME_STOP.has(tag.charCodeAt(at))) at += 1;
    if (at === start) {
      at += 1;
      continue;
    }
    const name = tag.slice(start, at);
    let next = at;
    while (next < to && isSpace(tag.charCodeAt(next))) next += 1;
    if (tag.charCodeAt(next) !== 61) {
      attributes.push({ name, value: undefined, valueStart: at, valueEnd: at, quote: "" });
      continue;
    }
    next += 1;
    while (next < to && isSpace(tag.charCodeAt(next))) next += 1;
    const quote = tag[next];
    if (quote === '"' || quote === "'") {
      const close = tag.indexOf(quote, next + 1);
      const valueEnd = close === -1 || close > to ? to : close;
      attributes.push({
        name,
        value: tag.slice(next + 1, valueEnd),
        valueStart: next + 1,
        valueEnd,
        quote,
      });
      at = valueEnd + 1;
      continue;
    }
    let valueEnd = next;
    while (
      valueEnd < to &&
      !isSpace(tag.charCodeAt(valueEnd)) &&
      !UNQUOTED_STOP.has(tag.charCodeAt(valueEnd))
    )
      valueEnd += 1;
    attributes.push({
      name,
      value: tag.slice(next, valueEnd),
      valueStart: next,
      valueEnd,
      quote: "",
    });
    at = Math.max(valueEnd, next + 1);
  }
  return attributes;
};

/** One start tag with the values that belong to secrets hidden. */
const maskStartTag = (tag: string, nameEnd: number, kind: string, base: string | undefined) => {
  const close = tag.endsWith("/>") ? 2 : tag.endsWith(">") ? 1 : 0;
  const attributes = attributesOf(tag, nameEnd, tag.length - close);
  const value = (name: string) =>
    attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value ?? "";
  const label = ["name", "id", "property", "http-equiv", "itemprop"].map(value).join(" ");
  const secretField =
    (kind === "input" && value("type").toLowerCase() === "password") || isSecretName(label);
  const out: string[] = [];
  let last = 0;
  for (const attribute of attributes) {
    if (attribute.value === undefined) continue;
    const name = attribute.name.toLowerCase();
    const current = attribute.value;
    let next = current;
    if ((name === "value" || name === "content") && secretField) next = hide(current);
    else if (kind === "input" && name === "value" && SECRET_VALUE.test(current.trim()))
      next = hide(current);
    else if (isSecretName(name) && !PLAIN_ATTRIBUTES.has(name)) next = hide(current);
    else if (URL_ATTRIBUTES.has(name)) next = maskUrlLike(current, base);
    else if (SRCSET_ATTRIBUTES.has(name)) next = maskSrcset(current, base);
    else if (name === "content") next = maskRefresh(current, base);
    else if (name.startsWith("data-")) next = maskDataJson(current, attribute.quote || '"');
    if (next === current) continue;
    out.push(tag.slice(last, attribute.valueStart), attribute.quote === "" ? `"${next}"` : next);
    last = attribute.valueEnd;
  }
  if (last === 0) return { tag, secretField };
  out.push(tag.slice(last));
  return { tag: out.join(""), secretField };
};

const isTagNameChar = (code: number) =>
  isAlnum(code) || code === 95 || code === 46 || code === 45 || code === 58;

/**
 * HTML and XML through a tolerant, iterative tokenizer: tags, comments, CDATA and text. Inputs
 * of any type, textareas, meta tags and attributes named like secrets have their values hidden;
 * the text and CDATA directly inside an element named like a secret are hidden; scripts get the
 * text rules.
 */
const maskMarkup = (text: string, base: string | undefined): CheckedBody => {
  const out: string[] = [];
  const lower = text.toLowerCase();
  const length = text.length;
  /** Open elements named like secrets, innermost last, with the other elements open inside. */
  const secretElements: Array<{ readonly kind: string; children: number }> = [];
  const inSecret = () => secretElements.at(-1)?.children === 0;
  const content = (part: string) =>
    inSecret() && part.trim() !== "" ? hide(part) : maskText(part);
  let at = 0;
  while (at < length) {
    const open = text.indexOf("<", at);
    if (open === -1) {
      out.push(content(text.slice(at)));
      break;
    }
    if (open > at) out.push(content(text.slice(at, open)));
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      const stop = end === -1 ? length : end + 3;
      out.push(maskText(text.slice(open, stop)));
      at = stop;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      out.push("<![CDATA[", content(text.slice(open + 9, end === -1 ? length : end)));
      if (end !== -1) out.push("]]>");
      at = end === -1 ? length : end + 3;
      continue;
    }
    let nameStart = open + 1;
    const closing = text.charCodeAt(nameStart) === 47;
    if (closing) nameStart += 1;
    if (!isLetter(text.charCodeAt(nameStart))) {
      out.push("<");
      at = open + 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < length && isTagNameChar(text.charCodeAt(nameEnd))) nameEnd += 1;
    let end = nameEnd;
    let quote = 0;
    while (end < length) {
      const code = text.charCodeAt(end);
      if (quote !== 0) {
        if (code === quote) quote = 0;
      } else if (code === 34 || code === 39) quote = code;
      else if (code === 62) break;
      end += 1;
    }
    const stop = Math.min(end + 1, length);
    const tag = text.slice(open, stop);
    const element = text.slice(nameStart, nameEnd);
    const kind = element.toLowerCase();
    at = stop;
    if (closing) {
      out.push(tag);
      const index = secretElements.findLastIndex((open) => open.kind === kind);
      if (index !== -1) secretElements.length = index;
      else if (secretElements.length > 0) {
        const top = secretElements.at(-1)!;
        top.children = Math.max(0, top.children - 1);
      }
      continue;
    }
    const masked = maskStartTag(tag, nameEnd - open, kind, base);
    out.push(masked.tag);
    if (tag.endsWith("/>")) continue;
    if (RAW_TEXT.has(kind)) {
      const closeAt = lower.indexOf(`</${kind}`, at);
      const contentEnd = closeAt === -1 ? length : closeAt;
      const inner = text.slice(at, contentEnd);
      out.push(kind === "textarea" && masked.secretField ? hide(inner) : content(inner));
      at = contentEnd;
      continue;
    }
    if (isSecretName(element)) {
      if (secretElements.length >= MAX_SECRET_ELEMENTS) return { leftOut: "too-deep" };
      secretElements.push({ kind, children: 0 });
    } else if (secretElements.length > 0 && !VOID_ELEMENTS.has(kind)) {
      secretElements.at(-1)!.children += 1;
    }
  }
  return { text: out.join("") };
};

const PART_GAP = /\r?\n\r?\n/u;

/** Multipart fields named like secrets are hidden and files left out; the parts stay. */
const maskMultipart = (
  text: string,
  contentType: string,
  base: string | undefined,
  depth: number,
): CheckedBody => {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType.slice(0, 1024));
  const marker = boundary?.[1] ?? boundary?.[2];
  if (marker === undefined) return { leftOut: "unparsed" };
  if (depth >= MAX_MULTIPART_DEPTH) return { leftOut: "too-deep" };
  const parts: string[] = [];
  for (const part of text.split(`--${marker}`)) {
    const gap = PART_GAP.exec(part);
    if (gap === null) {
      parts.push(part);
      continue;
    }
    const head = part.slice(0, gap.index);
    const scanned = head.slice(0, 4096);
    const body = part.slice(gap.index + gap[0].length);
    const ending = body.endsWith("\r\n") ? "\r\n" : body.endsWith("\n") ? "\n" : "";
    const value = body.slice(0, body.length - ending.length);
    const name = /name\s*=\s*(?:"([^"]*)"|([^;\s]+))/iu.exec(scanned);
    const field = name?.[1] ?? name?.[2] ?? "";
    const type = /content-type:\s*([^\r\n;]+)/iu.exec(scanned)?.[1] ?? "";
    let masked: string;
    if (/filename\s*=/iu.test(scanned)) masked = `<file ${value.length} bytes>`;
    else if (isSecretName(field)) masked = hide(value);
    else {
      const checked = checkBodyAt(value, type, base, depth + 1);
      if ("leftOut" in checked && checked.leftOut === "too-deep") return checked;
      masked = "text" in checked ? checked.text : hide(value);
    }
    parts.push(`${head}${gap[0]}${masked}${ending}`);
  }
  return { text: parts.join(`--${marker}`) };
};

const checkBodyAt = (
  text: string,
  contentType: string,
  base: string | undefined,
  depth: number,
): CheckedBody => {
  const type = contentType.toLowerCase().slice(0, 256);
  const json = type.includes("json");
  if (json || looksLikeJson(text)) {
    const masked = maskJsonText(text, false);
    if (masked !== undefined) return { text: masked };
    if (json && jsonDepth(text) > MAX_JSON_DEPTH) return { leftOut: "too-deep" };
    // Cut-off or broken JSON still gets the text rules, which read its pairs.
    if (json) return { text: maskText(text) };
  }
  if (type.includes("x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    return { text: maskParams(params) ?? params.toString() };
  }
  if (type.includes("multipart/")) return maskMultipart(text, contentType, base, depth);
  if (/html|xml|svg/u.test(type) || firstNonBlank(text) === 60) return maskMarkup(text, base);
  if (type === "" || /^text\/|javascript|ecmascript|graphql|csv/u.test(type))
    return { text: maskText(text) };
  return { leftOut: "unparsed" };
};

/**
 * A body with its secrets hidden, parsed by its format, or why it is left out: a format Scient
 * cannot parse, nesting past the limits, or more work than the budget. Known secrets in the
 * context are hidden too; `cut` marks a body shortened to its limit.
 */
export const checkBody = (
  text: string,
  contentType: string,
  context?: MaskContext,
  options: { readonly cut?: boolean; readonly workBudget?: number } = {},
): CheckedBody => {
  const checked = checkBodyAt(text, contentType, context?.base, 0);
  if (!("text" in checked) || context === undefined) return checked;
  const masked = knownMasker(context.secrets, options)(checked.text, options.cut);
  return masked === undefined ? { leftOut: "too-costly" } : { text: masked };
};

/** A body with its secrets hidden, or `undefined` when it is left out. */
export const maskBody = (
  text: string,
  contentType: string,
  context?: MaskContext,
): string | undefined => {
  const checked = checkBody(text, contentType, context);
  return "text" in checked ? checked.text : undefined;
};

const maskLink = (value: string, base: string | undefined) =>
  value
    .split(">")
    .map((piece) => {
      const at = piece.indexOf("<");
      return at === -1
        ? piece
        : `${piece.slice(0, at + 1)}${maskUrlLike(piece.slice(at + 1), base)}`;
    })
    .join(">");

/** Headers with credentials hidden, URL headers masked (relative ones too) and known values gone. */
export const maskHeaders = (headers: Readonly<Record<string, string>>, context?: MaskContext) => {
  const known = knownMasker(context?.secrets ?? []);
  const base = context?.base;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const header = name.toLowerCase();
      let masked: string;
      if (SECRET_HEADER.test(name)) masked = hide(value);
      else if (header === "location" || header === "content-location")
        masked = maskUrlLike(value, base);
      else if (header === "link") masked = maskLink(value, base);
      else if (header === "refresh") masked = maskRefresh(value, base);
      else if (URL_HEADER.test(name)) masked = maskText(value);
      else masked = maskValue(name, value);
      return [known(name) ?? hide(name), known(masked) ?? hide(value)];
    }),
  );
};

/**
 * The secret values in a request's own headers: cookie values sent and set, and the
 * Authorization credential (with and without its scheme).
 */
export const secretsInHeaders = (
  requestHeaders: Readonly<Record<string, string>>,
  responseHeaders: Readonly<Record<string, string>> | undefined,
) => {
  const found: string[] = [];
  const cookiePairs = (text: string) =>
    text.split(";").flatMap((pair) => {
      const at = pair.indexOf("=");
      return at === -1 ? [] : [pair.slice(at + 1).trim()];
    });
  for (const [name, value] of Object.entries(requestHeaders)) {
    const header = name.toLowerCase();
    if (header === "cookie") found.push(...cookiePairs(value));
    else if (header === "authorization" || header === "proxy-authorization") {
      found.push(value);
      const space = value.indexOf(" ");
      if (space !== -1) found.push(value.slice(space + 1));
    }
  }
  for (const [name, value] of Object.entries(responseHeaders ?? {})) {
    if (name.toLowerCase() !== "set-cookie") continue;
    for (const line of value.split("\n")) found.push(...cookiePairs(line.split(";")[0] ?? ""));
  }
  return found.filter((value) => value.length > 0);
};
