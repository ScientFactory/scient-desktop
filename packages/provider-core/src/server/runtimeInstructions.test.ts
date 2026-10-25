import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  // Every harness name takes the same interpolation path.
  it.each(["Codex"])("identifies the %s harness and describes media embedding", (harness) => {
    const instructions = buildRuntimeInstructions({ harness });
    expect(instructions).toContain(`running in T3 Code through the ${harness} harness.`);
    expect(instructions).toContain("embed images and videos");
    expect(instructions).toContain("Markdown with absolute file paths");
    expect(instructions).not.toContain("undefined");
  });

  it("uses the host product in agent wake-up instructions without renaming the MCP server", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", productName: "Scient" });
    expect(instructions).toContain("running in Scient through the Codex harness.");
    expect(instructions).toContain("Scient wakes you when checks finish");
    expect(instructions).toContain("MCP server named t3-code exposes link_pull_request");
    expect(instructions).toContain("As a delegated child task, do not watch or poll PRs");
    expect(instructions).not.toContain("T3 Code");
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
