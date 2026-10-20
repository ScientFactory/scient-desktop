/**
 * Keeps vendor credentials out of everything that leaves the connector
 * boundary toward an agent or a client.
 *
 * MCP results are JSON. A token-level rewriter walks the JSON text without
 * building objects: every token is copied through byte for byte, except a
 * string (value or key) or number whose decoded content carries a credential
 * Scient applied, which becomes the string `"[redacted by Scient]"`. Strings
 * are checked after JSON unescaping, tolerant percent and form decoding, and
 * base64/base64url decoding at every alignment. Untainted JSON is returned
 * unchanged (numbers keep their exact lexeme), output is always valid JSON,
 * and malformed, too deeply nested or otherwise unverifiable input is refused.
 *
 * SSE streams are parsed line by line per the specification (CRLF, CR, LF, or
 * mixed, across chunk boundaries) and re-rendered event by event; each event's
 * size is bounded by its own bytes.
 */

export const REDACTED = "[redacted by Scient]";
const REDACTED_TOKEN = JSON.stringify(REDACTED);

/**
 * Shorter credentials could not be told apart from ordinary text, so Scient
 * refuses to hold or apply them at all (entered keys, Basic passwords, issued
 * OAuth tokens and client secrets).
 */
export const MIN_CREDENTIAL_LENGTH = 16;

/** One SSE event may not exceed this many upstream bytes. */
export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

/** JSON nesting beyond this is refused rather than walked. */
export const MAX_JSON_DEPTH = 512;

/** Upper bound for an SSE `retry` value passed to the agent. */
export const MAX_SSE_RETRY_MS = 600_000;

const PERCENT_DECODE_ROUNDS = 3;
/** Base64 of the shortest credential is at least this long. */
const MIN_BASE64_RUN = Math.ceil((MIN_CREDENTIAL_LENGTH * 4) / 3) - 3;

export const isProtectableCredential = (value: string): boolean =>
  value.length >= MIN_CREDENTIAL_LENGTH;

/** The credentials one exchange applied or held, as matched against decoded text. */
export interface CredentialSet {
  readonly secrets: ReadonlyArray<string>;
  /** The same secrets as latin1 byte strings, for matching decoded base64. */
  readonly secretBytes: ReadonlyArray<string>;
}

export const credentialSet = (secrets: Iterable<string | undefined>): CredentialSet => {
  const unique = [
    ...new Set([...secrets].filter((secret): secret is string => secret !== undefined)),
  ];
  return {
    secrets: unique,
    secretBytes: unique.map((secret) => Buffer.from(secret, "utf8").toString("latin1")),
  };
};

const containsAny = (text: string, values: ReadonlyArray<string>) =>
  values.some((value) => text.includes(value));

const hexValue = (code: number): number =>
  code >= 48 && code <= 57
    ? code - 48
    : code >= 65 && code <= 70
      ? code - 55
      : code >= 97 && code <= 102
        ? code - 87
        : -1;

/** Decodes every valid `%XX` byte sequence in one linear pass; malformed escapes stay. */
const percentDecode = (text: string): string => {
  if (!text.includes("%")) return text;
  const parts: string[] = [];
  const bytes: number[] = [];
  let start = 0;
  const flush = () => {
    if (bytes.length === 0) return;
    const buffer = Buffer.from(bytes);
    const decoded = buffer.toString("utf8");
    parts.push(decoded.includes("\uFFFD") ? buffer.toString("latin1") : decoded);
    bytes.length = 0;
  };
  let index = 0;
  while (index < text.length) {
    const high = index + 2 < text.length ? hexValue(text.charCodeAt(index + 1)) : -1;
    const low = high >= 0 ? hexValue(text.charCodeAt(index + 2)) : -1;
    if (text.charCodeAt(index) === 37 && high >= 0 && low >= 0) {
      if (bytes.length === 0) parts.push(text.slice(start, index));
      bytes.push(high * 16 + low);
      index += 3;
      start = index;
      continue;
    }
    flush();
    index += 1;
  }
  flush();
  parts.push(text.slice(start));
  return parts.join("");
};

/** Percent decoding repeated until stable (at most three rounds), plain and form-encoded. */
const decodedVariants = (text: string): ReadonlyArray<string> => {
  const variants = new Set<string>([text]);
  const starts = text.includes("+") ? [text, text.replaceAll("+", " ")] : [text];
  for (const start of starts) {
    let current = start;
    variants.add(current);
    for (let round = 0; round < PERCENT_DECODE_ROUNDS; round += 1) {
      const next = percentDecode(current);
      if (next === current) break;
      variants.add(next);
      current = next;
    }
  }
  return [...variants];
};

const isBase64Char = (code: number) =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47 ||
  code === 45 ||
  code === 95;

const base64RunCarries = (run: string, credentials: CredentialSet): boolean => {
  const normalized = run.replaceAll("-", "+").replaceAll("_", "/");
  for (let shift = 0; shift < 4; shift += 1) {
    // Node decodes an unpadded final group, so the run's tail is not lost.
    const decoded = Buffer.from(normalized.slice(shift), "base64").toString("latin1");
    if (containsAny(decoded, credentials.secretBytes)) return true;
  }
  return false;
};

/**
 * True when any base64 or base64url run in `text`, decoded at each of its
 * possible alignments, contains a credential's bytes. Runs are found with a
 * single linear scan.
 */
const base64Carries = (text: string, credentials: CredentialSet): boolean => {
  let start = -1;
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && isBase64Char(text.charCodeAt(index))) {
      if (start === -1) start = index;
      continue;
    }
    if (start !== -1 && index - start >= MIN_BASE64_RUN) {
      if (base64RunCarries(text.slice(start, index), credentials)) return true;
    }
    start = -1;
  }
  return false;
};

/** Whether decoded text carries a credential in any supported encoding. */
export const isTainted = (text: string, credentials: CredentialSet): boolean => {
  if (credentials.secrets.length === 0 || text.length === 0) return false;
  for (const variant of decodedVariants(text)) {
    if (containsAny(variant, credentials.secrets)) return true;
    if (base64Carries(variant, credentials)) return true;
  }
  return false;
};

/** A string safe to show: the original, or the redaction marker. */
export const redactString = (text: string, credentials: CredentialSet): string =>
  isTainted(text, credentials) ? REDACTED : text;

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Lexes the JSON string starting at `start` (its opening quote). Returns the
 * index after the closing quote and the decoded content, or `undefined` when
 * the string is malformed.
 */
const lexString = (
  text: string,
  start: number,
): { readonly end: number; readonly decoded: string } | undefined => {
  const parts: string[] = [];
  let index = start + 1;
  let chunkStart = index;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 34) {
      parts.push(text.slice(chunkStart, index));
      return { end: index + 1, decoded: parts.join("") };
    }
    if (code < 0x20) return undefined;
    if (code !== 92) {
      index += 1;
      continue;
    }
    parts.push(text.slice(chunkStart, index));
    const escape = text[index + 1];
    if (escape === undefined) return undefined;
    if (escape === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
      index += 6;
    } else {
      const decoded = ESCAPES[escape];
      if (decoded === undefined) return undefined;
      parts.push(decoded);
      index += 2;
    }
    chunkStart = index;
  }
  return undefined;
};

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

type Expect = "value" | "valueOrEnd" | "key" | "keyOrEnd" | "colon" | "commaOrEnd" | "done";

/**
 * The redacted rewrite of a JSON document, or `undefined` when it is not
 * valid JSON or nests deeper than `MAX_JSON_DEPTH`. Untainted input is
 * returned byte for byte.
 */
export const redactJsonText = (text: string, credentials: CredentialSet): string | undefined => {
  const out: string[] = [];
  const stack: Array<"{" | "["> = [];
  let expect: Expect = "value";
  let copyFrom = 0;
  let index = 0;
  const afterValue = (): Expect => (stack.length === 0 ? "done" : "commaOrEnd");
  const replaceToken = (start: number, end: number) => {
    out.push(text.slice(copyFrom, start), REDACTED_TOKEN);
    copyFrom = end;
  };
  while (index < text.length) {
    const char = text[index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    if (expect === "done") return undefined;
    switch (char) {
      case "{":
      case "[":
        if (expect !== "value" && expect !== "valueOrEnd") return undefined;
        if (stack.length >= MAX_JSON_DEPTH) return undefined;
        stack.push(char);
        expect = char === "{" ? "keyOrEnd" : "valueOrEnd";
        index += 1;
        continue;
      case "}":
      case "]": {
        const open = char === "}" ? "{" : "[";
        const empty = char === "}" ? "keyOrEnd" : "valueOrEnd";
        if (stack.at(-1) !== open || (expect !== empty && expect !== "commaOrEnd")) {
          return undefined;
        }
        stack.pop();
        expect = afterValue();
        index += 1;
        continue;
      }
      case ",":
        if (expect !== "commaOrEnd") return undefined;
        expect = stack.at(-1) === "{" ? "key" : "value";
        index += 1;
        continue;
      case ":":
        if (expect !== "colon") return undefined;
        expect = "value";
        index += 1;
        continue;
      case '"': {
        const isKey = expect === "key" || expect === "keyOrEnd";
        if (!isKey && expect !== "value" && expect !== "valueOrEnd") return undefined;
        const lexed = lexString(text, index);
        if (lexed === undefined) return undefined;
        if (isTainted(lexed.decoded, credentials)) replaceToken(index, lexed.end);
        index = lexed.end;
        if (isKey) expect = "colon";
        else expect = afterValue();
        continue;
      }
      default: {
        if (expect !== "value" && expect !== "valueOrEnd") return undefined;
        const literal = ["true", "false", "null"].find((word) => text.startsWith(word, index));
        if (literal !== undefined) {
          index += literal.length;
          expect = afterValue();
          continue;
        }
        NUMBER.lastIndex = index;
        const number = NUMBER.exec(text);
        if (number === null) return undefined;
        const end = index + number[0].length;
        // A digits-only credential echoed as a JSON number.
        if (isTainted(number[0], credentials)) replaceToken(index, end);
        index = end;
        expect = afterValue();
        continue;
      }
    }
  }
  if (expect !== "done") return undefined;
  if (copyFrom === 0) return text;
  out.push(text.slice(copyFrom));
  return out.join("");
};

/** `redactJsonText`, with any sanitizer failure treated as unverifiable. */
const safelyRedactJson = (text: string, credentials: CredentialSet): string | undefined => {
  try {
    return redactJsonText(text, credentials);
  } catch {
    return undefined;
  }
};

/**
 * A complete JSON response body, redacted. Anything that is not JSON becomes
 * `refusal` (a Scient-written JSON-RPC error).
 */
export const redactJsonStream = (
  body: ReadableStream<Uint8Array>,
  credentials: CredentialSet,
  refusal: string,
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk) {
        parts.push(decoder.decode(chunk, { stream: true }));
      },
      flush(controller) {
        parts.push(decoder.decode());
        const redacted = safelyRedactJson(parts.join(""), credentials);
        controller.enqueue(new TextEncoder().encode(redacted ?? refusal));
      },
    }),
  );
};

/** The comment Scient sends in place of each upstream comment line. */
export const SSE_KEEPALIVE = ": keepalive\n";

interface PendingEvent {
  data: string[] | undefined;
  event: string | undefined;
  id: string | undefined;
  retry: string | undefined;
}

const emptyEvent = (): PendingEvent => ({
  data: undefined,
  event: undefined,
  id: undefined,
  retry: undefined,
});

/**
 * Re-renders one dispatched event. Data must be JSON (or empty, as in a
 * resumption priming event) and is redacted; a tainted event name or id is
 * dropped; `retry` passes only as an integer within `MAX_SSE_RETRY_MS`.
 * Returns `undefined` when non-empty data is not verifiable JSON.
 */
const renderEvent = (event: PendingEvent, credentials: CredentialSet): string | undefined => {
  const lines: string[] = [];
  if (event.event !== undefined && !isTainted(event.event, credentials)) {
    lines.push(`event: ${event.event}`);
  }
  if (event.id !== undefined && !isTainted(event.id, credentials)) lines.push(`id: ${event.id}`);
  if (event.retry !== undefined && /^\d{1,6}$/.test(event.retry)) {
    const retry = Number(event.retry);
    if (retry <= MAX_SSE_RETRY_MS) lines.push(`retry: ${retry}`);
  }
  if (event.data !== undefined) {
    const data = event.data.join("\n");
    if (data.length === 0) {
      lines.push("data:");
    } else {
      const redacted = safelyRedactJson(data, credentials);
      if (redacted === undefined) return undefined;
      // JSON keeps line breaks only in whitespace; each becomes its own data line.
      for (const line of redacted.split(/\r\n|\r|\n/)) lines.push(`data: ${line}`);
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
};

/**
 * An SSE body re-rendered event by event. Upstream comments are replaced by
 * one Scient keepalive comment each. An event whose data is not JSON, or
 * whose upstream bytes exceed `MAX_SSE_EVENT_BYTES`, is replaced by `refusal`
 * (a Scient-written JSON-RPC error event) and the stream ends.
 */
export const redactEventStream = (
  body: ReadableStream<Uint8Array>,
  credentials: CredentialSet,
  refusal: string,
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const refusalEvent = encoder.encode(`event: message\ndata: ${refusal}\n\n`);
  let line = "";
  let pendingCarriageReturn = false;
  let eventBytes = 0;
  let event = emptyEvent();
  let ended = false;

  const handleLine = (
    complete: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): boolean => {
    if (complete.length === 0) {
      const rendered = renderEvent(event, credentials);
      event = emptyEvent();
      eventBytes = 0;
      if (rendered === undefined) return false;
      if (rendered.length > 0) controller.enqueue(encoder.encode(rendered));
      return true;
    }
    if (complete.startsWith(":")) {
      controller.enqueue(encoder.encode(SSE_KEEPALIVE));
      return true;
    }
    const colon = complete.indexOf(":");
    const name = colon === -1 ? complete : complete.slice(0, colon);
    const value = colon === -1 ? "" : complete.slice(colon + 1).replace(/^ /, "");
    switch (name) {
      case "data":
        (event.data ??= []).push(value);
        break;
      case "event":
        event.event = value;
        break;
      case "id":
        if (!value.includes("\u0000")) event.id = value;
        break;
      case "retry":
        event.retry = value;
        break;
      default:
        break;
    }
    return true;
  };

  const refuse = (controller: TransformStreamDefaultController<Uint8Array>) => {
    ended = true;
    controller.enqueue(refusalEvent);
    controller.terminate();
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (ended) return;
        const text = decoder.decode(chunk, { stream: true });
        let index = 0;
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false;
          if (text.charCodeAt(0) === 10) index = 1;
        }
        let nextCr = text.indexOf("\r", index);
        let nextLf = text.indexOf("\n", index);
        while (index < text.length) {
          if (nextCr !== -1 && nextCr < index) nextCr = text.indexOf("\r", index);
          if (nextLf !== -1 && nextLf < index) nextLf = text.indexOf("\n", index);
          const end = nextCr === -1 ? nextLf : nextLf === -1 ? nextCr : Math.min(nextCr, nextLf);
          const piece = text.slice(index, end === -1 ? text.length : end);
          eventBytes += Buffer.byteLength(piece, "utf8") + (end === -1 ? 0 : 1);
          if (eventBytes > MAX_SSE_EVENT_BYTES) {
            refuse(controller);
            return;
          }
          line += piece;
          if (end === -1) break;
          if (text.charCodeAt(end) === 13) {
            if (end + 1 === text.length) pendingCarriageReturn = true;
            index = text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
          } else {
            index = end + 1;
          }
          const complete = line;
          line = "";
          if (!handleLine(complete, controller)) {
            refuse(controller);
            return;
          }
        }
      },
      // An event without its terminating blank line is incomplete and, per
      // the SSE specification, discarded at end of stream.
    }),
  );
};
