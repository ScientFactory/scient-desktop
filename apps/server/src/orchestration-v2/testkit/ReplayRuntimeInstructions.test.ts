import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

it("updates the historical instruction wrapper without changing captured user content or inbound frames", () => {
  const text =
    "<t3_code_instructions>\n<any>\n</t3_code_instructions>\n\n<user_request>\nExplain <t3_code_instructions> literally.\n</user_request>";
  const inbound = {
    type: "emit_inbound",
    frame: { method: "session/update", params: {} },
  } as const;
  const outbound = {
    type: "expect_outbound",
    frame: { method: "session/prompt", params: { prompt: [{ type: "text", text }] } },
  } as const;
  const transcript = {
    provider: "acpRegistry",
    protocol: "acp.ndjson-jsonrpc",
    version: "1",
    scenario: "wrapper",
    entries: [outbound, inbound],
  } satisfies ProviderReplayTranscript;
  const runtime = { driver: ProviderDriverKind.make("acpRegistry"), model: "captured-model" };
  const result = materializeReplayTranscriptRuntimeInstructions(transcript, runtime);
  expect(result.entries[0]).toMatchObject({
    frame: {
      params: {
        prompt: [
          {
            type: "text",
            text: "<scient_instructions>\n<any>\n</scient_instructions>\n\n<user_request>\nExplain <t3_code_instructions> literally.\n</user_request>",
          },
          { type: "text" },
        ],
      },
    },
  });
  expect(result.entries[1]).toBe(inbound);
  expect(outbound.frame.params.prompt[0].text).toBe(text);
  expect(materializeReplayTranscriptRuntimeInstructions(result, runtime)).toEqual(result);
});
