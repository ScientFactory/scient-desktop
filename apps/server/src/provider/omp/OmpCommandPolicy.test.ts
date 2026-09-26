import { describe, expect, it } from "vite-plus/test";

import { compileOmpCommandCatalog, ompCommandDecision } from "./OmpCommandPolicy.ts";

describe("Oh My Pi command policy", () => {
  const catalog = compileOmpCommandCatalog([
    { name: "help", description: "Show help", aliases: ["h"], source: "builtin" },
    { name: "new", aliases: ["n"], source: "builtin" },
    { name: "session", description: "Session operations", source: "builtin" },
    { name: "compact", source: "builtin" },
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
    // Oh My Pi resolves an unknown slash invocation as ordinary text.
    expect(ompCommandDecision("/unknown", catalog)).toBe("not-a-command");
  });

  it("forwards pasted paths and prose that open with a slash", () => {
    expect(ompCommandDecision("/Users/alice/notes.md", catalog)).toBe("not-a-command");
    expect(ompCommandDecision("/home/alice/project/src", catalog)).toBe("not-a-command");
    expect(ompCommandDecision("/usr/local/bin/omp update", catalog)).toBe("not-a-command");
    expect(ompCommandDecision("/ is a common path separator", catalog)).toBe("not-a-command");
  });

  it("stays fail-closed when command discovery is unavailable", () => {
    const undiscovered = compileOmpCommandCatalog([]);
    expect(ompCommandDecision("/help", undiscovered)).toBe("unavailable");
    expect(ompCommandDecision("/Users/alice/notes.md", undiscovered)).toBe("unavailable");
  });

  it("rejects aliases and side-effecting commands even when discovered", () => {
    const expanded = compileOmpCommandCatalog([
      { name: "new", aliases: ["n"], source: "builtin" },
      { name: "export", aliases: ["save"], source: "builtin" },
      { name: "share", aliases: ["publish"], source: "builtin" },
      { name: "model", aliases: ["m"], source: "builtin" },
      { name: "custom-extension-command", source: "extension" },
      { name: "compact", source: "extension" },
      { name: "help" },
    ]);
    expect(ompCommandDecision("/n", expanded)).toBe("mutator");
    expect(ompCommandDecision("/save", expanded)).toBe("mutator");
    expect(ompCommandDecision("/publish", expanded)).toBe("mutator");
    expect(ompCommandDecision("/m", expanded)).toBe("mutator");
    expect(ompCommandDecision("/custom-extension-command", expanded)).toBe("mutator");
    expect(expanded.advertised).toEqual([]);
    expect(ompCommandDecision("/help", expanded)).toBe("mutator");
    expect(ompCommandDecision("/compact", expanded)).toBe("mutator");
  });
});
