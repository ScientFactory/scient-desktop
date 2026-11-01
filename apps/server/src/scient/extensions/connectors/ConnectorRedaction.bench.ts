import { expect, it } from "vite-plus/test";

import { credentialSet, redactJsonStream } from "./ConnectorRedaction.ts";

it("scans a 32 MiB base64-like string in under 10,000ms", async ({ bench }) => {
  const body = `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"image","data":"${"QUJD".repeat((32 * 1024 * 1024 - 200) / 4)}"}]}}`;
  const context = {
    credentials: credentialSet(["tok/SYNTHETIC+secret=value\\x", "Z".repeat(20)]),
    agentIds: new Set<string>(),
    refusal: '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"withheld"}}',
  };
  const outputs: string[] = [];
  const measured = await bench("redact and collect 32 MiB JSON", { async: true }, async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const parts: string[] = [];
    const reader = redactJsonStream(stream, context)
      .pipeThrough(new TextDecoderStream())
      .getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      parts.push(chunk.value);
    }
    outputs.push(parts.join(""));
  }).run({ time: 0, iterations: 1, warmup: false, retainSamples: true });
  expect(outputs).toHaveLength(1);
  expect(outputs[0]!.length).toBe(body.length);
  expect(outputs[0] === body).toBe(true);
  expect(measured.latency.samples).toHaveLength(1);
  expect(measured.latency.mean).toBeLessThan(10_000);
});
