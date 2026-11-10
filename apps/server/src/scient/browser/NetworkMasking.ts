/**
 * What `preview_network` shows of a request: names, elements and ordinary values stay so an
 * agent can study a site; secrets go. Every value Scient knows is secret for the request is
 * hidden wherever it appears, and structure-aware rules hide values named like secrets.
 */

/** Values Scient knows are secret for one request, hidden wherever they appear. */
export interface MaskContext {
  readonly secrets: ReadonlyArray<string>;
  /** The request's own address, to resolve relative URLs. */
  readonly base?: string | undefined;
}

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$/iu;
const URL_HEADER = /^(location|content-location|referer|origin|refresh|link)$/iu;
/** Words that make a key, attribute, element or field name a secret's. */
const SECRET_NAME =
  /(token|secret|passw|pwd|pass_?code|session|sess_?id|sesskey|csrf|xsrf|auth|api[-_]?key|apikey|signature|bearer|cookie|nonce|otp|code_verifier|credential|private[-_]?key)/iu;
const SECRET_VALUE =
  /^(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/u;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/gu;
const QUOTED_TOKEN = /(["'])([A-Za-z0-9+/_-]{40,}={0,2}|[A-Fa-f0-9]{32,})\1/gu;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>`,;]+/gu;
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
/** Elements whose content is text up to their end tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
/** Known secrets shorter than this would mangle ordinary text. */
const MIN_KNOWN = 4;

const hide = (value: string) => `<hidden ${value.length} chars>`;

const isSecretName = (name: string) => SECRET_NAME.test(name);

const maskValue = (name: string, value: string) =>
  isSecretName(name) || SECRET_VALUE.test(value.trim()) ? hide(value) : value;

/** Every known secret, as written raw, URL-encoded, form-encoded or JSON-escaped. */
export const maskKnown = (text: string, context: MaskContext | undefined) => {
  if (context === undefined) return text;
  let result = text;
  const secrets = [...new Set(context.secrets)]
    .filter((secret) => secret.length >= MIN_KNOWN)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    const encoded = encodeURIComponent(secret);
    for (const form of new Set([
      secret,
      encoded,
      encoded.replaceAll("%20", "+"),
      JSON.stringify(secret).slice(1, -1),
    ])) {
      if (form.length >= MIN_KNOWN) result = result.replaceAll(form, hide(secret));
    }
  }
  return result;
};

const maskParams = (params: URLSearchParams) => {
  let changed = false;
  for (const [name, value] of Array.from(params)) {
    const masked = maskValue(name, value);
    if (masked !== value) {
      params.set(name, masked);
      changed = true;
    }
  }
  return changed;
};

/** Query and fragment values named like secrets, or that look like tokens, are hidden. */
export const maskUrl = (raw: string) => {
  if (!URL.canParse(raw)) return raw.slice(0, 2048);
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  maskParams(url.searchParams);
  if (url.hash.length > 1) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (maskParams(fragment)) url.hash = fragment.toString();
  }
  return url.toString().slice(0, 2048);
};

/**
 * An absolute or relative URL with its secrets hidden; a relative one is resolved against the
 * request, masked, and written back as relative. Unchanged URLs keep their exact spelling.
 */
const maskUrlLike = (value: string, base: string | undefined) => {
  const trimmed = value.trim();
  if (trimmed === "" || /^(javascript|data|mailto|tel):/iu.test(trimmed)) return value;
  const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) || trimmed.startsWith("//");
  const resolved = URL.canParse(trimmed, base ?? "https://scient.invalid/")
    ? new URL(trimmed, base ?? "https://scient.invalid/")
    : undefined;
  if (resolved === undefined) return value;
  const masked = new URL(maskUrl(resolved.toString()));
  if (masked.toString() === resolved.toString() && !resolved.username && !resolved.password)
    return value;
  if (absolute && !trimmed.startsWith("//")) return masked.toString();
  // Keep what was written before the query, and give back only the masked query and fragment.
  const cut = trimmed.search(/[?#]/u);
  const written = cut === -1 ? trimmed : trimmed.slice(0, cut);
  return `${written}${masked.search}${masked.hash}`;
};

const maskUrlsInText = (text: string) =>
  text.replace(URL_IN_TEXT, (url) => maskUrlLike(url, undefined));

/**
 * Plain text, scripts and config: `"key": "value"`, `key = 'value'`, `key=value` and
 * `key: value` pairs named like secrets, absolute URLs, JWTs and long quoted tokens.
 */
const maskText = (text: string) =>
  maskUrlsInText(
    text
      .replace(
        /(["']?)([\w.$-]*?)\1(\s*[:=]\s*)(["'])((?:\\.|(?!\4)[^\\\n])*)\4/gu,
        (whole, keyQuote: string, key: string, sep: string, quote: string, value: string) =>
          isSecretName(key) && value.length > 0
            ? `${keyQuote}${key}${keyQuote}${sep}${quote}${hide(value)}${quote}`
            : whole,
      )
      .replace(
        /(^|[\s&;?,{(])([\w.$-]+)(=|:[ \t]*)([^\s&;,"'<>(){}]+)/gmu,
        (whole, lead: string, key: string, sep: string, value: string) =>
          isSecretName(key) && !value.startsWith("<hidden")
            ? `${lead}${key}${sep}${hide(value)}`
            : whole,
      )
      .replace(JWT, (token) => hide(token))
      .replace(
        QUOTED_TOKEN,
        (_whole, quote: string, token: string) => `${quote}${hide(token)}${quote}`,
      ),
  );

interface Attribute {
  readonly name: string;
  readonly value: string | undefined;
  /** The attribute exactly as written, with its leading space. */
  readonly raw: string;
  readonly quote: string;
}

const ATTRIBUTE = /(\s+)([^\s"'<>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

const attributesOf = (inside: string): ReadonlyArray<Attribute> =>
  Array.from(inside.matchAll(ATTRIBUTE), (match) => {
    const value = match[4] ?? match[5] ?? match[6];
    const quote = match[4] !== undefined ? '"' : match[5] !== undefined ? "'" : "";
    return { name: match[2]!, value, raw: match[0], quote };
  });

const rewriteAttribute = (attribute: Attribute, value: string) => {
  const at = attribute.raw.indexOf("=");
  const head = attribute.raw.slice(0, at + 1).replace(/\s*$/u, "");
  const spacing = attribute.raw.slice(head.length).match(/^\s*/u)?.[0] ?? "";
  return `${head}${spacing}${attribute.quote}${value}${attribute.quote}`;
};

/** One start tag with the values that belong to secrets hidden. */
const maskStartTag = (tag: string, element: string, base: string | undefined) => {
  const nameEnd = tag.indexOf(element) + element.length;
  const close = tag.endsWith("/>") ? "/>" : tag.endsWith(">") ? ">" : "";
  const inside = tag.slice(nameEnd, tag.length - close.length);
  const attributes = attributesOf(inside);
  const value = (name: string) =>
    attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value ?? "";
  const label = ["name", "id", "property", "http-equiv", "itemprop"].map(value).join(" ");
  const kind = element.toLowerCase();
  const secretField =
    (kind === "input" && value("type").toLowerCase() === "password") || isSecretName(label);
  let rewritten = inside;
  for (const attribute of attributes) {
    if (attribute.value === undefined) continue;
    const name = attribute.name.toLowerCase();
    let next = attribute.value;
    if ((name === "value" || name === "content") && secretField) next = hide(attribute.value);
    else if (kind === "input" && name === "value" && SECRET_VALUE.test(attribute.value.trim()))
      next = hide(attribute.value);
    else if (isSecretName(name) && !PLAIN_ATTRIBUTES.has(name)) next = hide(attribute.value);
    else if (URL_ATTRIBUTES.has(name)) next = maskUrlLike(attribute.value, base);
    else if (name === "content" && /url=/iu.test(attribute.value))
      next = attribute.value.replace(
        /(url=)(.*)$/iu,
        (_w, lead: string, url: string) => `${lead}${maskUrlLike(url, base)}`,
      );
    if (next !== attribute.value)
      rewritten = rewritten.replace(attribute.raw, rewriteAttribute(attribute, next));
  }
  return { tag: `${tag.slice(0, nameEnd)}${rewritten}${close}`, secretField };
};

/**
 * HTML and XML through a tolerant tokenizer: tags, comments and text. Inputs of any type,
 * textareas, meta tags and attributes named like secrets have their values hidden; an XML
 * element named like a secret has its text hidden; scripts get the text rules.
 */
const maskMarkup = (text: string, base: string | undefined): string => {
  const out: string[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) {
      out.push(maskText(text.slice(at)));
      break;
    }
    out.push(maskText(text.slice(at, open)));
    if (text.startsWith("<!--", open) || text.startsWith("<![CDATA[", open)) {
      const ender = text.startsWith("<!--", open) ? "-->" : "]]>";
      const end = text.indexOf(ender, open);
      const stop = end === -1 ? text.length : end + ender.length;
      out.push(maskText(text.slice(open, stop)));
      at = stop;
      continue;
    }
    const head = /^<(\/?)([A-Za-z][\w:.-]*)/u.exec(text.slice(open, open + 256));
    if (head === null) {
      out.push("<");
      at = open + 1;
      continue;
    }
    let end = open + head[0].length;
    let quote = "";
    while (end < text.length) {
      const char = text[end]!;
      if (quote !== "") {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      end += 1;
    }
    const stop = Math.min(end + 1, text.length);
    const tag = text.slice(open, stop);
    const element = head[2]!;
    const closing = head[1] === "/";
    if (closing) {
      out.push(tag);
      at = stop;
      continue;
    }
    const masked = maskStartTag(tag, element, base);
    out.push(masked.tag);
    at = stop;
    const kind = element.toLowerCase();
    if (tag.endsWith("/>")) continue;
    if (RAW_TEXT.has(kind) || isSecretName(element)) {
      const closeAt = lower.indexOf(`</${kind}`, at);
      const contentEnd = closeAt === -1 ? text.length : closeAt;
      const content = text.slice(at, contentEnd);
      if (kind === "textarea") out.push(masked.secretField ? hide(content) : maskText(content));
      else if (RAW_TEXT.has(kind)) out.push(maskText(content));
      else if (content.includes("<")) out.push(maskMarkup(content, base));
      else out.push(content.trim() === "" ? content : hide(content));
      at = contentEnd;
    }
  }
  return out.join("");
};

/** Multipart fields named like secrets are hidden and files left out; the parts stay. */
const maskMultipart = (text: string, contentType: string) => {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (marker === undefined) return undefined;
  return text
    .split(`--${marker}`)
    .map((part) => {
      const gap = /\r?\n\r?\n/u.exec(part);
      if (gap === null) return part;
      const head = part.slice(0, gap.index);
      const body = part.slice(gap.index + gap[0].length);
      const ending = /\r?\n$/u.exec(body)?.[0] ?? "";
      const value = body.slice(0, body.length - ending.length);
      const name = /name\s*=\s*(?:"([^"]*)"|([^;\s]+))/iu.exec(head);
      const field = name?.[1] ?? name?.[2] ?? "";
      const type = /content-type:\s*([^\r\n;]+)/iu.exec(head)?.[1] ?? "";
      const masked = /filename\s*=/iu.test(head)
        ? `<file ${value.length} bytes>`
        : isSecretName(field)
          ? hide(value)
          : (maskBody(value, type) ?? hide(value));
      return `${head}${gap[0]}${masked}${ending}`;
    })
    .join(`--${marker}`);
};

const maskJson = (value: unknown, key = ""): unknown => {
  if (typeof value === "string") return maskValue(key, value);
  if (typeof value === "number" && isSecretName(key)) return hide(String(value));
  if (Array.isArray(value)) return value.map((item) => maskJson(item, key));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, maskJson(item, name)]),
    );
  return value;
};

/**
 * A body with its secrets hidden, parsed by its format; `undefined` for one Scient cannot parse,
 * which is then left out rather than shown raw.
 */
export const maskBody = (
  text: string,
  contentType: string,
  context?: MaskContext,
): string | undefined => {
  const type = contentType.toLowerCase();
  const known = (masked: string | undefined) =>
    masked === undefined ? undefined : maskKnown(masked, context);
  if (type.includes("json") || /^\s*[[{]/u.test(text)) {
    try {
      return known(JSON.stringify(maskJson(JSON.parse(text)), null, 1));
    } catch {
      // Not JSON after all.
    }
  }
  if (type.includes("x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    maskParams(params);
    for (const [name, value] of Array.from(params))
      if (isSecretName(name) && !value.startsWith("<hidden")) params.set(name, hide(value));
    return known(params.toString());
  }
  if (type.includes("multipart/")) return known(maskMultipart(text, contentType));
  if (/html|xml|svg/u.test(type) || /^\s*</u.test(text))
    return known(maskMarkup(text, context?.base));
  if (type === "" || /^text\/|javascript|ecmascript|graphql|csv/u.test(type))
    return known(maskText(text));
  return undefined;
};

/** Headers with credentials hidden, URL headers masked (relative ones too) and known values gone. */
export const maskHeaders = (headers: Readonly<Record<string, string>>, context?: MaskContext) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (SECRET_HEADER.test(name)) return [name, hide(value)];
      let masked: string;
      const header = name.toLowerCase();
      if (header === "location" || header === "content-location")
        masked = maskUrlLike(value, context?.base);
      else if (header === "link")
        masked = value.replace(
          /<([^>]*)>/gu,
          (_w, url: string) => `<${maskUrlLike(url, context?.base)}>`,
        );
      else if (header === "refresh")
        masked = value.replace(
          /(url=)(.*)$/iu,
          (_w, lead: string, url: string) => `${lead}${maskUrlLike(url, context?.base)}`,
        );
      else if (URL_HEADER.test(name)) masked = maskUrlsInText(value);
      else masked = maskValue(name, value);
      return [name, maskKnown(masked, context)];
    }),
  );

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
    text.split(/;\s*/u).flatMap((pair) => {
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
