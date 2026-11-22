import { SCIENT_FEEDBACK_ORIGIN } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  feedbackEndpoint,
  redactLogText,
  rendererCrashesSince,
  runsFixedVersion,
  tailLines,
  traceFailuresSince,
} from "./feedbackLogic.ts";

describe("feedbackEndpoint", () => {
  it("sends release builds to Scient and development builds nowhere", () => {
    const release = { isPackaged: true, isDevelopment: false, testEndpoint: undefined };
    expect(feedbackEndpoint(release)).toBe(SCIENT_FEEDBACK_ORIGIN);
    expect(feedbackEndpoint({ ...release, isDevelopment: true })).toBeNull();
    expect(feedbackEndpoint({ ...release, isPackaged: false })).toBeNull();
  });

  it("accepts only a loopback test endpoint", () => {
    const dev = { isPackaged: false, isDevelopment: true };
    expect(feedbackEndpoint({ ...dev, testEndpoint: "http://127.0.0.1:8790" })).toBe(
      "http://127.0.0.1:8790",
    );
    expect(feedbackEndpoint({ ...dev, testEndpoint: "https://evil.example" })).toBeNull();
    expect(feedbackEndpoint({ ...dev, testEndpoint: "http://user:pw@127.0.0.1:1" })).toBeNull();
  });
});

describe("redactLogText", () => {
  it("masks the home folder and secret-shaped values but keeps ordinary text", () => {
    const text = [
      "opened /Users/ada/Research/notes.md",
      "Authorization: Bearer abcdefghijklmnop123",
      'config {"api_key": "sk-proj-abcdefghijklmnopqrstuv"}',
      "token=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "https://ada:hunter2@proxy.example:8080",
      "turn finished in 812 ms",
    ].join("\n");
    const redacted = redactLogText(text, "/Users/ada");
    expect(redacted).toContain("opened ~/Research/notes.md");
    expect(redacted).not.toMatch(/abcdefghijklmnop123|sk-proj|ghp_|hunter2/);
    expect(redacted).toContain("turn finished in 812 ms");
  });

  it("masks a Windows home folder written with either slash", () => {
    const redacted = redactLogText(
      "C:\\Users\\Ada\\a.txt and C:/Users/Ada/b.txt",
      "C:\\Users\\Ada",
    );
    expect(redacted).toBe("~\\a.txt and ~/b.txt");
  });
});

describe("tailLines", () => {
  it("keeps the end of a long log from a whole line", () => {
    const tail = tailLines("first line\nsecond line\nthird line\n", 16);
    expect(tail).toBe("third line\n");
  });
});

describe("rendererCrashesSince", () => {
  it("counts main-window crashes inside the window and skips torn lines", () => {
    const now = 1_800_000_000_000;
    const record = (timestampUnixMs: number, surface = "main") =>
      JSON.stringify({ event: "render-process-gone", surface, timestampUnixMs, reason: "oom" });
    const history = [
      record(now - 1000),
      record(now - 2000, "preview"),
      record(now - 2 * 86_400_000),
      '{"event":"render-process-gone","surf',
    ].join("\n");
    expect(rendererCrashesSince(history, now - 86_400_000)).toHaveLength(1);
  });
});

describe("traceFailuresSince", () => {
  it("reads failed operations newest first, once per trace, without interruptions or older ones", () => {
    const now = 1_800_000_000_000;
    const span = (name: string, endedMs: number, extra: Record<string, unknown>) =>
      JSON.stringify({
        name,
        traceId: `trace-${name}`,
        endTimeUnixNano: String(BigInt(endedMs) * 1_000_000n),
        ...extra,
      });
    const trace = [
      span("provider.turn", now - 5000, { exit: { _tag: "Failure", cause: "Codex exited 1" } }),
      span("pdf.render", now - 1000, { status: { code: "2", message: "Failure: bad page" } }),
      span("turn.stop", now - 500, {
        exit: { _tag: "Failure" },
        status: { message: "Interrupted" },
      }),
      span("old.failure", now - 3 * 86_400_000, { exit: { _tag: "Failure", cause: "old" } }),
      span("ok", now - 100, { exit: { _tag: "Success" } }),
      JSON.stringify({
        name: "provider.turn.inner",
        traceId: "trace-provider.turn",
        endTimeUnixNano: String(BigInt(now - 6000) * 1_000_000n),
        exit: { _tag: "Failure", cause: "Codex exited 1" },
      }),
    ].join("\n");
    expect(traceFailuresSince(trace, now - 86_400_000)).toEqual([
      {
        name: "pdf.render",
        endedAtMs: now - 1000,
        traceId: "trace-pdf.render",
        cause: "Failure: bad page",
      },
      {
        name: "provider.turn",
        endedAtMs: now - 5000,
        traceId: "trace-provider.turn",
        cause: "Codex exited 1",
      },
    ]);
  });
});

describe("runsFixedVersion", () => {
  it("compares release numbers, ignoring prerelease tags", () => {
    expect(runsFixedVersion("0.6.31", "0.6.31")).toBe(true);
    expect(runsFixedVersion("0.6.31-beta.20261120.1", "0.6.31")).toBe(true);
    expect(runsFixedVersion("0.6.30", "0.6.31")).toBe(false);
    expect(runsFixedVersion("0.10.0", "0.9.9")).toBe(true);
    expect(runsFixedVersion("unknown", "0.6.31")).toBe(false);
  });
});
