import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { materializeScientMuseRequests } from "./MuseAdapterV2.testkit.ts";

const runtimeText =
  "<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as original-model with high reasoning effort.</runtime_info>\n\nWhen the t3-code MCP server exposes link_pull_request. T3 Code wakes you when checks finish.";

function transcript(entries: ProviderReplayTranscript["entries"]): ProviderReplayTranscript {
  return {
    provider: "muse",
    protocol: "muse.msp-jsonl",
    version: "1.4.3",
    scenario: "scient-identity",
    entries,
  };
}

describe("Muse recorded Scient request identity", () => {
  it("adapts only known outbound identity and guidance while preserving native protocol fields", () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 41,
      method: "initialize",
      params: {
        clientInfo: { name: "t3_code", title: "T3 Code", version: "1" },
        capabilities: { requestedCapabilities: ["sessionMcp"] },
      },
    };
    const turn = {
      jsonrpc: "2.0",
      id: 43,
      method: "turn/start",
      params: {
        sessionId: "native-session",
        commandId: "native-command",
        reasoningEffort: "high",
        workspaceRoots: ["/recorded-workspace"],
        ifBusy: "queue",
        input: [
          { type: "text", text: runtimeText },
          { type: "text", text: "Discuss T3 Code without rewriting my prompt" },
        ],
        displayText: "Discuss T3 Code without rewriting my prompt",
      },
    };
    const inbound = {
      type: "emit_inbound" as const,
      frame: {
        jsonrpc: "2.0",
        id: 41,
        result: { serverInfo: { name: "muse", title: "T3 Code", version: "1.4.3" } },
      },
    };
    const input = transcript([
      { type: "expect_outbound", frame: initialize },
      inbound,
      { type: "expect_outbound", frame: turn },
    ]);
    const materialized = materializeScientMuseRequests(input);
    assert.strictEqual(materialized.entries[1], inbound);
    assert.deepEqual(materialized.entries[0], {
      type: "expect_outbound",
      frame: {
        ...initialize,
        params: {
          ...initialize.params,
          clientInfo: { ...initialize.params.clientInfo, title: "Scient" },
        },
      },
    });
    assert.deepEqual(materialized.entries[2], {
      type: "expect_outbound",
      frame: {
        ...turn,
        params: {
          ...turn.params,
          input: [
            {
              ...turn.params.input[0],
              text: runtimeText
                .replace("in T3 Code through", "in Scient through")
                .replace("the t3-code MCP server", "the Scient MCP server")
                .replace("T3 Code wakes", "Scient wakes"),
            },
            turn.params.input[1],
          ],
        },
      },
    });
    assert.strictEqual(initialize.params.clientInfo.title, "T3 Code");
    assert.strictEqual(turn.params.input[0]!.text, runtimeText);
    assert.deepEqual(materializeScientMuseRequests(materialized), materialized);
  });

  it("leaves unrelated identity and user-written runtime-like text untouched", () => {
    const input = transcript([
      {
        type: "expect_outbound",
        frame: {
          method: "initialize",
          params: { clientInfo: { name: "another-client", title: "T3 Code" } },
        },
      },
      {
        type: "expect_outbound",
        frame: {
          method: "turn/start",
          params: {
            input: [{ type: "text", text: "User says T3 Code wakes you when checks finish" }],
          },
        },
      },
      {
        type: "emit_inbound",
        frame: { method: "turn/start", params: { input: [{ type: "text", text: runtimeText }] } },
      },
    ]);
    assert.deepEqual(materializeScientMuseRequests(input), input);
    input.entries.forEach((entry, index) =>
      assert.strictEqual(materializeScientMuseRequests(input).entries[index], entry),
    );
  });
});
