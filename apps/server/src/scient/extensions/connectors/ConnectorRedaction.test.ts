import { describe, expect, it } from "vite-plus/test";

import {
  credentialSet,
  isProtectableCredential,
  MAX_JSON_DEPTH,
  MAX_SSE_EVENT_BYTES,
  REDACTED,
  redactEventStream,
  redactJsonStream,
  redactJsonText,
  SSE_KEEPALIVE,
} from "./ConnectorRedaction.ts";

const TOKEN = "tok/SYNTHETIC+secret=value\\x";
const credentials = credentialSet([TOKEN]);
const REFUSAL = '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"withheld"}}';
const REFUSAL_EVENT = `event: message\ndata: ${REFUSAL}\n\n`;

const unicodeEscaped = (text: string) =>
  [...text].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

const base64At = (prefix: string, url = false) =>
  Buffer.from(`${prefix}${TOKEN} trailing`).toString(url ? "base64url" : "base64");

const streamOf = (chunks: ReadonlyArray<string>, close = true) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (close) controller.close();
    },
  });

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const parts: string[] = [];
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    parts.push(chunk.value);
  }
  return parts.join("");
};

const sse = (chunks: ReadonlyArray<string>, secrets = credentials) =>
  collect(redactEventStream(streamOf(chunks), secrets, REFUSAL));

const eventData = (output: string) =>
  output
    .split("\n\n")
    .filter((event) => event.split("\n").some((line) => line.startsWith("data: ")))
    .map(
      (event) =>
        JSON.parse(
          event
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice("data: ".length))
            .join("\n"),
        ) as unknown,
    );

describe("token-level JSON redaction", () => {
  it("redacts every equivalent encoding of a credential in values and keys", () => {
    const lowerPercent = encodeURIComponent(TOKEN).replace(/%[0-9A-F]{2}/g, (escape) =>
      escape.toLowerCase(),
    );
    const variants = [
      TOKEN,
      `Bearer ${TOKEN}`,
      encodeURIComponent(TOKEN),
      lowerPercent,
      encodeURIComponent(encodeURIComponent(TOKEN)),
      encodeURIComponent(encodeURIComponent(encodeURIComponent(TOKEN))),
      new URLSearchParams({ t: TOKEN }).toString(),
      `prefix ${base64At("")}`,
      base64At("a"),
      base64At("ab"),
      base64At("abc", true),
    ];
    const raw = `{"unicode":"${unicodeEscaped(TOKEN)}","values":${JSON.stringify(variants)},${JSON.stringify(TOKEN)}:1,"nested":{"deep":[{"x":${JSON.stringify(`k=${TOKEN}`)}}]},"keep":"ordinary text","n":3}`;
    const output = redactJsonText(raw, credentials);
    expect(output).toBeDefined();
    expect(JSON.parse(output!)).toEqual({
      unicode: REDACTED,
      values: variants.map(() => REDACTED),
      [REDACTED]: 1,
      nested: { deep: [{ x: REDACTED }] },
      keep: "ordinary text",
      n: 3,
    });
    expect(output).not.toContain("SYNTHETIC");
  });

  it("returns untainted JSON byte for byte, including big integers and __proto__", () => {
    const raw =
      '{ "jsonrpc" : "2.0",\n  "id": 9007199254740993,\r\n "result": {"__proto__": {"value": 3}, "ok": 1, ' +
      '"exp": 1.50E+300, "neg": -0.0, "esc": "\\u00e9\\n\\/", "list": [true, false, null, [], {}]}}';
    expect(redactJsonText(raw, credentials)).toBe(raw);
    expect(redactJsonText(raw, credentialSet([]))).toBe(raw);
  });

  it("replaces only a tainted number lexeme and keeps every other number exact", () => {
    const digits = credentialSet(["12345678901234567"]);
    expect(
      redactJsonText('{"id":1,"v":12345678901234567,"big":98765432109876543210}', digits),
    ).toBe(`{"id":1,"v":${JSON.stringify(REDACTED)},"big":98765432109876543210}`);
  });

  it("refuses nesting beyond the limit without recursion and accepts it up to the limit", () => {
    const array = (depth: number) => `${"[".repeat(depth)}0${"]".repeat(depth)}`;
    const object = (depth: number) => `${'{"a":'.repeat(depth)}0${"}".repeat(depth)}`;
    expect(redactJsonText(array(MAX_JSON_DEPTH), credentials)).toBe(array(MAX_JSON_DEPTH));
    expect(redactJsonText(array(MAX_JSON_DEPTH + 1), credentials)).toBeUndefined();
    expect(redactJsonText(object(MAX_JSON_DEPTH + 1), credentials)).toBeUndefined();
    expect(redactJsonText(array(200_000), credentials)).toBeUndefined();
  });

  it("refuses malformed JSON", () => {
    for (const bad of [
      "",
      "{",
      '{"a":1,}',
      "[1 2]",
      "01",
      '"unterminated',
      '"bad \\q escape"',
      '{"a"}',
      "true false",
      "nul",
      `"raw\ncontrol"`,
    ]) {
      expect(redactJsonText(bad, credentials), bad).toBeUndefined();
    }
  });

  it("scans a 32 MiB base64-like string linearly and without stack growth", async () => {
    const body = `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"image","data":"${"QUJD".repeat((32 * 1024 * 1024 - 200) / 4)}"}]}}`;
    const started = performance.now();
    const output = await collect(
      redactJsonStream(streamOf([body]), credentialSet([TOKEN, "Z".repeat(20)]), REFUSAL),
    );
    const elapsed = performance.now() - started;
    expect(output.length).toBe(body.length);
    expect(output === body).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("answers the refusal for a JSON body that cannot be verified", async () => {
    expect(await collect(redactJsonStream(streamOf(["not json"]), credentials, REFUSAL))).toBe(
      REFUSAL,
    );
  });

  it("refuses credentials too short to tell apart from ordinary text", () => {
    expect(isProtectableCredential("x".repeat(15))).toBe(false);
    expect(isProtectableCredential("x".repeat(16))).toBe(true);
  });
});

describe("SSE re-rendering", () => {
  it("yields valid JSON for every chunk split around escapes", async () => {
    const event = `event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"echo":${JSON.stringify(`${TOKEN}\\`)},"note":"a\\\\b"}}\n\n`;
    for (let split = 1; split < event.length; split += 1) {
      const output = await sse([event.slice(0, split), event.slice(split)]);
      expect(eventData(output), `split ${split}`).toEqual([
        { jsonrpc: "2.0", id: 7, result: { echo: REDACTED, note: "a\\b" } },
      ]);
    }
  });

  it("passes empty-data priming events and the reply that follows", async () => {
    const output = await sse([
      "id: cursor-1\nretry: 1000\ndata:\n\n",
      'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
    ]);
    expect(output).toBe(
      'id: cursor-1\nretry: 1000\ndata:\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
    );
  });

  it("never passes a retry that is out of range or carries a digits-only credential", async () => {
    const digits = credentialSet(["1234567890123456"]);
    expect(await sse(['retry: 1234567890123456\ndata: {"ok":true}\n\n'], digits)).toBe(
      'data: {"ok":true}\n\n',
    );
    expect(await sse(["retry: 600001\nretry: x\nid: a\n\n"], digits)).toBe("id: a\n\n");
    expect(await sse(["retry: 600000\n\n"], digits)).toBe("retry: 600000\n\n");
  });

  it("drops credential-bearing ids and replaces comments with a fixed keepalive", async () => {
    const output = await sse([
      `: debug ${TOKEN}\nid: ${encodeURIComponent(TOKEN)}\ndata: {"a":1}\n\n`,
      `id: cursor-2\nretry: 1000\ndata: {"b":2}\n\n`,
    ]);
    expect(output).toBe(
      `${SSE_KEEPALIVE}data: {"a":1}\n\nid: cursor-2\nretry: 1000\ndata: {"b":2}\n\n`,
    );
  });

  it("sends a keepalive for an upstream comment while the stream stays open", async () => {
    const reader = redactEventStream(streamOf([": ping\n"], false), credentials, REFUSAL)
      .pipeThrough(new TextDecoderStream())
      .getReader();
    expect((await reader.read()).value).toBe(SSE_KEEPALIVE);
    await reader.cancel();
  });

  it("parses CRLF, CR, LF and mixed line endings, split anywhere", async () => {
    const stream = 'data: {"a":1}\n\r\ndata: {"b":2}\r\rid: x\r\ndata: {"c":3}\r\n\r\n';
    for (let split = 0; split <= stream.length; split += 1) {
      const output = await sse([stream.slice(0, split), stream.slice(split)]);
      expect(output, `split ${split}`).toBe(
        'data: {"a":1}\n\ndata: {"b":2}\n\nid: x\ndata: {"c":3}\n\n',
      );
    }
  });

  it("re-renders multi-line JSON data as one data line per line", async () => {
    const output = await sse(['data: {\ndata:   "a": 1\ndata: }\n\n']);
    expect(output).toBe('data: {\ndata:   "a": 1\ndata: }\n\n');
    expect(eventData(output)).toEqual([{ a: 1 }]);
  });

  it("bounds each event by its own bytes, whatever the chunking", async () => {
    const payload = (bytes: number) => `data: "${"é".repeat(bytes / 2)}"\n\n`;
    const over = payload(MAX_SSE_EVENT_BYTES);
    const under = payload(MAX_SSE_EVENT_BYTES - 64);
    expect(await sse([over])).toBe(REFUSAL_EVENT);
    expect(await sse([over.slice(0, -10), over.slice(-10)])).toBe(REFUSAL_EVENT);
    expect(await sse([under])).toBe(under);
    expect(await sse([under.slice(0, 7), under.slice(7)])).toBe(under);
  });

  it("ends the stream with a Scient error for non-JSON data", async () => {
    expect(await sse([`data: plain ${TOKEN}\n\n`, 'data: {"later":true}\n\n'])).toBe(REFUSAL_EVENT);
  });
});
