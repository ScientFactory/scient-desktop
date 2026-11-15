/**
 * Native error text is shown in the thread and stored with it, and threads can be shared, so
 * paths keep only their last name and personal or credential-like values become a placeholder.
 */
const REDACTED_FAILURE_VALUE = "[REDACTED]";

const LABEL =
  "[\\w-]*(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth[_-]?token|authorization|client[_-]?secret|credentials?|passw(?:or)?d|pwd|secret|session[_-]?id|token)";

// Windows names cannot hold a colon, so a spaced name never runs into a later "https:".
const WIN_NAME = String.raw`[^\s"'<>|*?:\\/]+`;
const POSIX_NAME = String.raw`[^\s"'<>|;,()\[\]{}:/]+`;
// A path that is only a home folder names its owner.
const HOME_FOLDER = /^(?:[A-Za-z]:[\\/]|\/)(?:Users|home)[\\/][^\\/]+[\\/]?$/iu;

const PATTERN = new RegExp(
  [
    // Path-terminating characters double as URL ends so a quoted or bracketed URL stays intact.
    String.raw`(?<url>\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>()\[\]{}]+)`,
    String.raw`(?<email>(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)`,
    String.raw`(?<scheme>\b(?:Bearer|Basic)\s+)[^\s"',;]+`,
    String.raw`(?<label>(?<![\w-])${LABEL}["']?\s*[:=]\s*["']?)[^\s"',;&]+`,
    String.raw`(?<key>\bAIza[\w-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bxox[abposre]-[A-Za-z0-9-]{10,}|\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*|\bsk-[\w-]{16,})`,
    // A quoted path is one span, spaces and all.
    String.raw`(?<qpath>(?<q>["'])(?<qinner>(?:\\\\|[A-Za-z]:[\\/]|~?\/)[^"'\n]*)\k<q>)`,
    // A home folder that ends the text: its name may have spaces and nothing delimits it.
    String.raw`(?<homeend>(?<![\w\\/])(?:[A-Za-z]:[\\/]|\/)(?:Users|home)[\\/][^\\/\n"'<>|]+$)`,
    // UNC and other backslash paths, then drive-letter and POSIX/home paths. A folder name may
    // contain spaces when a separator follows it ("C:\Users\Jane Doe\key.json").
    String.raw`(?<winpath>(?<![\w\\])(?:(?:\\\\|[A-Za-z]:\\)(?:${WIN_NAME}(?: ${WIN_NAME})*\\)*|[A-Za-z]:\/(?:${WIN_NAME}(?: ${WIN_NAME})*\/)*)(?:${WIN_NAME})?|(?<![\w\\/])[\w.$~-]+(?:\\[^\s"'<>|*?\\]+)+)`,
    String.raw`(?<posixpath>(?<![\w.:/~-])~?\/(?:(?:${POSIX_NAME}(?: ${POSIX_NAME})*\/)+(?:${POSIX_NAME})?|${POSIX_NAME}))`,
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
const pathName = (path: string) =>
  HOME_FOLDER.test(path.replace(TRAILING_PUNCTUATION, ""))
    ? REDACTED_FAILURE_VALUE
    : redactFailureDetail(basename(path));

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
    if (groups.qpath !== undefined) return `${groups.q}${pathName(groups.qinner ?? "")}${groups.q}`;
    if (groups.homeend !== undefined) return REDACTED_FAILURE_VALUE;
    if (groups.winpath !== undefined || groups.posixpath !== undefined) return pathName(match);
    if (groups.b64 !== undefined && !ENTROPIC.test(match)) return match;
    return REDACTED_FAILURE_VALUE;
  });
}
