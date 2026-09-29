import { describe, expect, it } from "vite-plus/test";
import { nativeThreadKey } from "./nativeThreadKey.ts";

describe("native conversation identity", () => {
  it.each([
    ["codex", { threadId: "native-id" }],
    ["claudeAgent", { resume: "native-id", threadId: "scient-id" }],
    ["pi", { sessionId: "native-id", sessionFile: "/session.jsonl" }],
    ["omp", { sessionId: "native-id", relativeSessionFile: "session.jsonl" }],
  ])("keeps %s identity stable as its resume cursor becomes durable", (provider, cursor) => {
    const live = nativeThreadKey(provider, undefined, "configured-instance", "native-id");
    expect(live).not.toBeNull();
    expect(nativeThreadKey(provider, cursor, "configured-instance", "native-id")).toBe(live);
    expect(nativeThreadKey(provider, cursor, "configured-instance")).toBe(live);
    expect(nativeThreadKey(provider, cursor, "different-instance")).not.toBe(live);
    expect(nativeThreadKey(provider, cursor, "configured-instance", "replacement")).not.toBe(live);
  });

  it("does not use a stale persisted cursor instead of the live identity", () => {
    expect(nativeThreadKey("codex", { threadId: "old" }, "instance", "new")).toBe(
      "codex@instance:new",
    );
  });

  it.each([undefined, null, {}, [], { sessionId: "" }])(
    "leaves unknown identity unknown (%j)",
    (cursor) => {
      expect(nativeThreadKey("pi", cursor, "instance")).toBeNull();
    },
  );
});
