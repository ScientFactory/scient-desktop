import { describe, expect, it } from "vite-plus/test";

import {
  agentRequestIds,
  credentialSet,
  isProtectableCredential,
  MAX_JSON_DEPTH,
  MAX_SSE_EVENT_BYTES,
  REDACTED,
  redactEventStream,
  redactJsonStream,
  redactJsonText,
  requestIdToken,
  SSE_KEEPALIVE,
  SSE_KEEPALIVE_INTERVAL_MS,
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

const context = (secrets = credentials, agentIds: ReadonlySet<string> = new Set()) => ({
  credentials: secrets,
  agentIds,
  refusal: REFUSAL,
});

const sse = (chunks: ReadonlyArray<string>, secrets = credentials) =>
  collect(redactEventStream(streamOf(chunks), context(secrets)));

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

  it("refuses a tainted number rather than changing its type, keeping other numbers exact", () => {
    const digits = credentialSet(["12345678901234567"]);
    expect(
      redactJsonText('{"id":1,"v":12345678901234567,"big":98765432109876543210}', digits),
    ).toBeUndefined();
    expect(redactJsonText('{"id":1,"big":98765432109876543210}', digits)).toBe(
      '{"id":1,"big":98765432109876543210}',
    );
  });

  it("returns a request's id token exactly as the agent wrote it", () => {
    expect(requestIdToken('{"jsonrpc":"2.0","id":9007199254740993,"method":"x"}')).toBe(
      "9007199254740993",
    );
    expect(requestIdToken('{"id":"a\\u0062","params":{"id":1}}')).toBe('"a\\u0062"');
    expect(requestIdToken('{"jsonrpc":"2.0","method":"notify"}')).toBe("null");
    expect(requestIdToken('[{"id":1}]')).toBe("null");
    expect(requestIdToken("{not json")).toBe("null");
  });

  it("keeps a tainted message id only when the agent sent that exact id", () => {
    const digits = credentialSet(["1234567890123456"]);
    const reply = '{"jsonrpc":"2.0","id":1234567890123456,"result":{"ok":true}}';
    const sent = agentRequestIds(
      '{"jsonrpc":"2.0","id":1234567890123456,"method":"tools/call","params":{"id":7}}',
    );
    expect([...sent]).toEqual(["number:1234567890123456"]);
    expect(redactJsonText(reply, digits, sent)).toBe(reply);
    // Not the agent's id, or the same digits as a string id: refused, never retyped.
    expect(redactJsonText(reply, digits)).toBeUndefined();
    expect(
      redactJsonText('{"jsonrpc":"2.0","id":"1234567890123456","result":{}}', digits, sent),
    ).toBeUndefined();
    // Inside a batch the element's top-level id counts; nested ids are ordinary values.
    expect(redactJsonText(`[${reply}]`, digits, sent)).toBe(`[${reply}]`);
    expect(
      redactJsonText('{"jsonrpc":"2.0","id":1,"result":{"id":"1234567890123456"}}', digits, sent),
    ).toBe(`{"jsonrpc":"2.0","id":1,"result":{"id":${JSON.stringify(REDACTED)}}}`);
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

  it("preserves a 32 MiB base64-like string without stack growth", async () => {
    const body = `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"image","data":"${"QUJD".repeat((32 * 1024 * 1024 - 200) / 4)}"}]}}`;
    const output = await collect(
      redactJsonStream(streamOf([body]), context(credentialSet([TOKEN, "Z".repeat(20)]))),
    );
    expect(output.length).toBe(body.length);
    expect(output === body).toBe(true);
  });

  it("answers the refusal for a JSON body that cannot be verified", async () => {
    expect(await collect(redactJsonStream(streamOf(["not json"]), context()))).toBe(REFUSAL);
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

  it("drops credential-bearing ids and never echoes comments", async () => {
    const output = await sse([
      `: debug ${TOKEN}\nid: ${encodeURIComponent(TOKEN)}\ndata: {"a":1}\n\n`,
      `id: cursor-2\nretry: 1000\ndata: {"b":2}\n\n`,
    ]);
    expect(output).toBe(
      `${SSE_KEEPALIVE}data: {"a":1}\n\nid: cursor-2\nretry: 1000\ndata: {"b":2}\n\n`,
    );
  });

  it("sends a keepalive for an upstream comment while the stream stays open", async () => {
    const reader = redactEventStream(streamOf([": ping\n"], false), context())
      .pipeThrough(new TextDecoderStream())
      .getReader();
    expect((await reader.read()).value).toBe(SSE_KEEPALIVE);
    await reader.cancel();
  });

  it("coalesces keepalives to one per interval and none after other output", async () => {
    let clock = 0;
    const flood = ":\n".repeat(100_000);
    const run = (chunks: ReadonlyArray<string>) =>
      collect(redactEventStream(streamOf(chunks), context(), () => clock));
    expect(await run([flood])).toBe(SSE_KEEPALIVE);
    // An event went out in this window, so the following comments add nothing.
    expect(await run(['data: {"a":1}\n\n', ":\n:\n"])).toBe('data: {"a":1}\n\n');
    const paced = redactEventStream(streamOf([":\n", ":\n", ":\n"]), context(), () => {
      clock += SSE_KEEPALIVE_INTERVAL_MS / 2;
      return clock;
    });
    // Comments every half interval: the clock advances at each check, one keepalive per interval.
    expect(await collect(paced)).toBe(SSE_KEEPALIVE.repeat(2));
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

  it("counts CRLF as two upstream bytes, also when split across chunks", async () => {
    const event = `data: "${"x".repeat(MAX_SSE_EVENT_BYTES - 10)}"\r\n\r\n`;
    expect(Buffer.byteLength(event)).toBe(MAX_SSE_EVENT_BYTES + 2);
    expect(await sse([event])).toBe(REFUSAL_EVENT);
    expect(await sse([event.slice(0, -3), event.slice(-3)])).toBe(REFUSAL_EVENT);
    expect(await sse([event.slice(0, -1), event.slice(-1)])).toBe(REFUSAL_EVENT);
    const ignoredFields = `${"x\r\n".repeat(1_500_000)}data: {"ok":true}\r\n\r\n`;
    expect(await sse([ignoredFields])).toBe(REFUSAL_EVENT);
  });

  it("charges a split final LF to the event that owns the CR, never to the next", async () => {
    const eventOf = (size: number, ending = "\r\n\r\n") => `data: "${"x".repeat(size)}"${ending}`;
    const rendered = (size: number) => `data: "${"x".repeat(size)}"\n\n`;
    const tooBig = eventOf(MAX_SSE_EVENT_BYTES - 11);
    expect(Buffer.byteLength(tooBig)).toBe(MAX_SSE_EVENT_BYTES + 1);
    for (const split of [1, 2, 3, 4]) {
      expect(await sse([tooBig.slice(0, -split), tooBig.slice(-split)])).toBe(REFUSAL_EVENT);
    }
    // Two events of exactly the cap, each split between its final CR and LF.
    const atCap = eventOf(MAX_SSE_EVENT_BYTES - 12);
    expect(Buffer.byteLength(atCap)).toBe(MAX_SSE_EVENT_BYTES);
    expect(
      await sse([atCap.slice(0, -1), `\n${atCap.slice(0, -1)}`, "\n", 'data: {"next":1}\n\n']),
    ).toBe(
      `${rendered(MAX_SSE_EVENT_BYTES - 12)}${rendered(MAX_SSE_EVENT_BYTES - 12)}data: {"next":1}\n\n`,
    );
    // A held event at the cap is released when its CR is not followed by LF.
    const crOnly = eventOf(MAX_SSE_EVENT_BYTES - 10, "\r\r");
    expect(Buffer.byteLength(crOnly)).toBe(MAX_SSE_EVENT_BYTES);
    expect(await sse([crOnly])).toBe(rendered(MAX_SSE_EVENT_BYTES - 10));
    expect(await sse([crOnly, 'data: {"next":1}\r\r'])).toBe(
      `${rendered(MAX_SSE_EVENT_BYTES - 10)}data: {"next":1}\n\n`,
    );
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
