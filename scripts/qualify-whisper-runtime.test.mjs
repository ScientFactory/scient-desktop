import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import {
  EXPECTED_PHRASE,
  normalizeTranscript,
  QUALIFICATION_MODEL,
  QUALIFICATION_RECORDING,
  traceRuntime,
} from "./qualify-whisper-runtime.mjs";
import { WHISPER_CPP_COMMIT } from "./stage-whisper-runtime.ts";

describe("qualify-whisper-runtime", () => {
  it("pins the model and the recording", () => {
    expect(QUALIFICATION_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(QUALIFICATION_RECORDING.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(QUALIFICATION_RECORDING.url).toContain(WHISPER_CPP_COMMIT);
  });

  it("compares words, not punctuation or case", () => {
    expect(
      normalizeTranscript(
        " And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
      ),
    ).toContain(EXPECTED_PHRASE);
    expect(normalizeTranscript("Ask not!\n  What your-country")).toBe("ask not what your country");
  });

  it("explains a failed transcription with its phases, exit and the end of the server's output", async () => {
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      pid: 42,
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
    });
    const trace = traceRuntime({
      spawn: () => child,
      fetch: async (_url, init) => {
        if (init?.method === "OPTIONS") return new Response(null, { status: 200 });
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    trace.spawn("whisper-server", [], {});
    child.stderr.write("x".repeat(9000));
    child.stderr.write("whisper_init: model loaded\n");
    await trace.fetch("http://127.0.0.1:1/scient-secret/inference", { method: "OPTIONS" });
    await expect(
      trace.fetch("http://127.0.0.1:1/scient-secret/inference", { method: "POST" }),
    ).rejects.toThrow("aborted");
    child.emit("exit", null, "SIGTERM");

    const report = trace.report();
    expect(report).toMatch(/spawned server \(pid 42\)/u);
    expect(report).toMatch(/OPTIONS inference: 200/u);
    expect(report).toMatch(/POST inference: AbortError/u);
    expect(report).toMatch(/server exited \(code null, signal SIGTERM\)/u);
    expect(report).toContain("whisper_init: model loaded");
    expect(report).not.toContain("x".repeat(8192));
    expect(report).not.toContain("scient-secret");
  });
});
