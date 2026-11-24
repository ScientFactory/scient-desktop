import { expect, it } from "vite-plus/test";

import { loadNativeSpeechModel } from "./native.ts";

it("escalates after a long-job worker ignores SIGTERM and awaits its exit", async () => {
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`
    process.on("SIGTERM", () => {});
    export const TranscribeModel = { load: async () => ({
      capabilities: {}, supports: () => false,
      transcribe: async () => ({ text: String(process.pid) }),
    }) };
  `)}`;
  const controller = new AbortController();
  const worker = await loadNativeSpeechModel(
    "unused.gguf",
    controller.signal,
    moduleUrl,
    "cpu",
    true,
  );
  const { text } = await worker.recognizeWindow(new Float32Array(4_000));
  controller.abort();
  await worker.dispose();
  expect(() => process.kill(Number(text), 0)).toThrow();
});
