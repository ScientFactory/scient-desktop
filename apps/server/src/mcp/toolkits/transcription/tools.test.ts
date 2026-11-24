import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ScientTranscriptionToolkit } from "./tools.ts";

const decode = Schema.decodeUnknownSync(
  ScientTranscriptionToolkit.tools.scient_transcription_start.parametersSchema,
);

it("retains checkpoint and provider selections through MCP input decoding", () => {
  const selection = {
    source: "audio.wav",
    resume: "2026-11-22-audio-abcd1234",
    providerInstanceId: "my-codex",
  };
  expect(decode(selection)).toEqual(selection);
});
