/**
 * Native error text is shown in the thread and stored with it, and threads can be shared, so
 * paths keep only their last name and personal or credential-like values become a placeholder.
 */
const REDACTED_FAILURE_VALUE = "[REDACTED]";

const LABEL =
  "[\\w-]*(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth[_-]?token|authorization|client[_-]?secret|credentials?|passw(?:or)?d|pwd|secret|session[_-]?id|token)";

const PATTERN = new RegExp(
  [
    // Path-terminating characters double as URL ends so a quoted or bracketed URL stays intact.
    String.raw`(?<url>\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>()\[\]{}]+)`,
    String.raw`(?<email>(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)`,
    String.raw`(?<scheme>\b(?:Bearer|Basic)\s+)[^\s"',;]+`,
    String.raw`(?<label>(?<![\w-])${LABEL}["']?\s*[:=]\s*["']?)[^\s"',;&]+`,
    String.raw`(?<key>\bAIza[\w-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bxox[abposre]-[A-Za-z0-9-]{10,}|\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|\bsk-[\w-]{16,})`,
    // UNC and other backslash paths, then drive-letter and POSIX/home paths.
    String.raw`(?<winpath>(?<![\w\\])(?:\\\\|[A-Za-z]:\\|[A-Za-z]:\/)[^\s"'<>|*?]*|(?<![\w\\/])[\w.$~-]+(?:\\[^\s"'<>|*?\\]+)+)`,
    String.raw`(?<posixpath>(?<![\w.:/~-])~?\/[^\s"'<>|;,()\[\]{}]+)`,
    String.raw`(?<hex>\b[0-9a-fA-F]{32,}\b)`,
    String.raw`(?<b64>(?<![\w+/=-])[A-Za-z0-9+/_-]{40,}={0,2})`,
  ].join("|"),
  "gu",
);

const TRAILING_PUNCTUATION = /[.,:;!?]+$/u;
const ENTROPIC = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])/u;

function basename(path: string): string {
  const trailing = TRAILING_PUNCTUATION.exec(path)?.[0] ?? "";
  const name = path
    .slice(0, path.length - trailing.length)
    .split(/[\\/]+/u)
    .findLast((segment) => segment.length > 0);
  return `${name ?? REDACTED_FAILURE_VALUE}${trailing}`;
}

// A path's last name can itself be a key or an address.
const pathName = (path: string) => redactFailureDetail(basename(path));

function redactUrl(text: string): string {
  const trailing = TRAILING_PUNCTUATION.exec(text)?.[0] ?? "";
  const value = text.slice(0, text.length - trailing.length);
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return pathName(decodeURIComponent(url.pathname)) + trailing;
    const path =
      url.pathname === "/" && !value.endsWith("/")
        ? ""
        : url.pathname
            .split("/")
            .map((segment) => redactFailureDetail(segment))
            .join("/");
    return `${url.protocol}//${url.host}${path}${trailing}`;
  } catch {
    return REDACTED_FAILURE_VALUE + trailing;
  }
}

/** Redacts one line of native error text; apply before bounding its length. */
export function redactFailureDetail(text: string): string {
  return text.replace(PATTERN, (match, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    if (groups.url !== undefined) return redactUrl(match);
    if (groups.scheme !== undefined) return `${groups.scheme}${REDACTED_FAILURE_VALUE}`;
    if (groups.label !== undefined) return `${groups.label}${REDACTED_FAILURE_VALUE}`;
    if (groups.winpath !== undefined || groups.posixpath !== undefined) return pathName(match);
    if (groups.b64 !== undefined && !ENTROPIC.test(match)) return match;
    return REDACTED_FAILURE_VALUE;
  });
}
