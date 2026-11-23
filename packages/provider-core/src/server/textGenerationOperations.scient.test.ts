import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

it.effect("uses a native correction object while preserving the legacy string contract", () =>
  Effect.gen(function* () {
    const segments = [
      { id: "0-2", start: 1.25, end: 2.5, text: "Ana Bell", uncertain: false, protected: true },
    ];
    const service = fromRunner("Stub", (request) =>
      decodeJsonReply(
        request,
        "Stub",
        request.structuredCorrection
          ? JSON.stringify({ segments, suggestions: [] })
          : '{"transcription":"Anna Bell"}',
      ),
    );
    const input = {
      cwd: ".",
      prompt: "Correct the segment.",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "configured",
      },
    };
    const corrected = yield* service.generateTranscriptionPostProcessing({
      ...input,
      structuredCorrection: "initial",
    });
    assert.deepEqual(JSON.parse(corrected.transcription), { segments, suggestions: [] });
    assert.deepEqual(yield* service.generateTranscriptionPostProcessing(input), {
      transcription: "Anna Bell",
    });
  }),
);
