import * as NodeAssert from "node:assert/strict";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";
// SCIENT-FORK:START — Scient awareness carries the device block.
import { SCIENT_DEVICE_TOOL_INSTRUCTIONS } from "./ScientProviderInstructions.ts";
// SCIENT-FORK:END

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([
      undefined,
      new Set<McpCapability>(),
      new Set<McpCapability>(["preview"]),
      new Set<McpCapability>(["device"]),
      new Set<McpCapability>(["preview", "device"]),
      new Set<McpCapability>(["preview", "device", "compute", "documents:build", "skills:read"]),
    ])("keeps every entry within Codex's per-entry cap with tools %j", (availability) => {
      const context = buildCodexAdditionalContext(runtime, availability);

      for (const [key, entry] of Object.entries(context)) {
        // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
        const bytes = Buffer.byteLength(entry.value, "utf8");
        const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
        NodeAssert.ok(
          bytes <= limit,
          `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
        );
      }
    });
  });
});

describe("Codex runtime context", () => {
  it("describes Markdown media and file links in the runtime context", () => {
    NodeAssert.match(
      runtimeInstructions({ model: "gpt-5.3-codex", reasoningEffort: "high" }),
      /<runtime_info>.*embed images, video, and audio.*Markdown image syntax with absolute file paths.*Link any other file.*absolute path.*Scient's files viewer.*<\/runtime_info>/,
    );
  });

  it("names Scient, the Codex harness, the model and the effort", () => {
    const instructions = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.match(instructions, /Scient/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Scient browser awareness", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools when preview is granted", () => {
    const instructions = toolInstructions(runtime, true);
    NodeAssert.match(instructions, /Scient browser/);
    NodeAssert.match(instructions, /preview_status/);
    NodeAssert.match(instructions, /preview_open/);
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    const instructions = toolInstructions(runtime, false);
    NodeAssert.doesNotMatch(instructions, /preview_status/);
    NodeAssert.doesNotMatch(instructions, /preview_open/);
    NodeAssert.doesNotMatch(instructions, /Scient browser/);
  });
});

describe("Codex orchestration context", () => {
  it("routes subagents native first, delegate_task for the rest", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(orchestration.includes("use your native tool when the child uses your provider"));
    NodeAssert.ok(orchestration.includes("`run_in_background:false`"));
    NodeAssert.ok(orchestration.includes("A native type running another provider's model"));
    NodeAssert.ok(
      orchestration.includes("Every new delegate review or re-check is a new `delegate_task`"),
    );
    NodeAssert.ok(orchestration.includes("never a `scient_thread_send`"));
    NodeAssert.ok(!orchestration.includes("inheritedOptions"));
    NodeAssert.ok(!orchestration.includes("Prefer native"));
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});

describe("Codex device context", () => {
  it("adds the shared device block only when the session holds device access", () => {
    // SCIENT-FORK:START — Scient awareness carries the device block for granted capabilities.
    const tools = (device: boolean) =>
      Object.entries(
        buildCodexAdditionalContext(
          { model: "gpt-6.1-sol" },
          new Set<McpCapability>(device ? ["preview", "device"] : ["preview"]),
        ),
      )
        .filter(([key]) => key.startsWith("scient_awareness"))
        .map(([, entry]) => entry.value)
        .join("\n\n");

    NodeAssert.ok(tools(true).includes(SCIENT_DEVICE_TOOL_INSTRUCTIONS));
    NodeAssert.ok(!tools(true).includes("ToolSearch"));
    NodeAssert.ok(!tools(false).includes("## Scient devices"));
    // SCIENT-FORK:END
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}
function toolInstructions(
  runtime: Parameters<typeof buildCodexAdditionalContext>[0],
  available: boolean,
) {
  const awareness = buildCodexAdditionalContext(
    runtime,
    available ? new Set(["preview"] as const) : new Set(),
  ).scient_awareness;
  if (!awareness) throw new Error("Missing Scient awareness context");
  return awareness.value;
}
