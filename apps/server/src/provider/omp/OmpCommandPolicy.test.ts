import { describe, expect, it } from "vite-plus/test";

import { compileOmpCommandCatalog, ompCommandDecision } from "./OmpCommandPolicy.ts";

describe("Oh My Pi command policy", () => {
  const catalog = compileOmpCommandCatalog([
    { name: "help", description: "Show help", aliases: ["h"] },
    { name: "new", aliases: ["n"] },
    { name: "session", description: "Session operations" },
    { name: "compact" },
  ]);

  it("advertises useful commands and hides session mutators", () => {
    expect(catalog.advertised.map((command) => command.name)).toEqual(["help", "compact"]);
    expect(ompCommandDecision("/help the patch", catalog)).toBe("allowed");
    expect(ompCommandDecision("/h", catalog)).toBe("allowed");
    expect(ompCommandDecision("/compact", catalog)).toBe("allowed");
    expect(ompCommandDecision("plain text", catalog)).toBe("not-a-command");
  });

  it("rejects session replacement even when Oh My Pi advertises it", () => {
    expect(ompCommandDecision("/new", catalog)).toBe("mutator");
    expect(ompCommandDecision("/n", catalog)).toBe("mutator");
    expect(ompCommandDecision("/session delete", catalog)).toBe("mutator");
    expect(ompCommandDecision("/session info", catalog)).toBe("allowed");
    expect(ompCommandDecision("/session\tinfo", catalog)).toBe("allowed");
    expect(ompCommandDecision("/unknown", catalog)).toBe("unavailable");
  });

  it("rejects aliases and side-effecting commands even when discovered", () => {
    const expanded = compileOmpCommandCatalog([
      { name: "new", aliases: ["n"] },
      { name: "export", aliases: ["save"] },
      { name: "share", aliases: ["publish"] },
      { name: "model", aliases: ["m"] },
      { name: "custom-extension-command" },
      { name: "compact", source: "extension" },
    ]);
    expect(ompCommandDecision("/n", expanded)).toBe("mutator");
    expect(ompCommandDecision("/save", expanded)).toBe("mutator");
    expect(ompCommandDecision("/publish", expanded)).toBe("mutator");
    expect(ompCommandDecision("/m", expanded)).toBe("mutator");
    expect(ompCommandDecision("/custom-extension-command", expanded)).toBe("mutator");
    expect(expanded.advertised).toEqual([]);
    expect(ompCommandDecision("/compact", expanded)).toBe("mutator");
  });
});
