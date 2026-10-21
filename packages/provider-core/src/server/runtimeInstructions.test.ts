import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the MCP server named t3-code exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "identifies the %s harness and describes media embedding",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(`running in T3 Code through the ${harness} harness.`);
      expect(instructions).toContain("embed images and videos");
      expect(instructions).toContain("Markdown with absolute file paths");
      expect(instructions).not.toContain("undefined");
    },
  );

  it("uses the host product in agent wake-up instructions without renaming the MCP server", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", productName: "Scient" });
    expect(instructions).toContain("running in Scient through the Codex harness.");
    expect(instructions).toContain("Scient wakes you when checks finish");
    expect(instructions).toContain("MCP server named t3-code exposes link_pull_request");
    expect(instructions).toContain("As a delegated child task, do not watch or poll PRs");
    expect(instructions).not.toContain("T3 Code");
  });
  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("lets a host replace product identity and product policy without changing formatting", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Cursor",
      model: "model-1",
      productName: "Host Product",
      pullRequestLinkingInstructions: "<host_policy>Link through the host.</host_policy>",
    });
    expect(instructions).toContain(
      "running in Host Product through the Cursor harness, as model-1.",
    );
    expect(instructions).toContain("<host_policy>Link through the host.</host_policy>");
    expect(instructions).not.toContain("<pull_request_linking>");
  });
});
