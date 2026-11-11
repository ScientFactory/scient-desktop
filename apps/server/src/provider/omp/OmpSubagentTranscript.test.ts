// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  OMP_SUBAGENT_TRANSCRIPT_START,
  readOmpSubagentTranscript,
} from "./OmpSubagentTranscript.ts";

const record = (id: string, message: unknown) =>
  `${JSON.stringify({ type: "message", id, parentId: null, message })}\n`;
const text = (role: string, value: string) => ({ role, content: [{ type: "text", text: value }] });

const transcriptFile = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-subagent-transcript-"));
  return {
    file: NodePath.join(root, "Child.jsonl"),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

it.layer(NodeServices.layer)("OMP subagent transcript", (it) => {
  it.effect("waits for a record still being written, then continues where it stopped", () =>
    Effect.gen(function* () {
      using transcript = transcriptFile();
      const answer = record("a2", text("assistant", "Done."));
      NodeFS.writeFileSync(
        transcript.file,
        record("a1", text("user", "Assignment")) + answer.slice(0, 20),
      );
      const first = yield* readOmpSubagentTranscript(
        transcript.file,
        OMP_SUBAGENT_TRANSCRIPT_START,
      );
      // The assignment is not a step, and half a record is not read.
      assert.deepEqual(first.steps, []);
      NodeFS.appendFileSync(transcript.file, answer.slice(20));
      const second = yield* readOmpSubagentTranscript(transcript.file, first.cursor);
      assert.deepEqual(second.steps, [
        { kind: "text", id: "a2:0", role: "assistant", text: "Done." },
      ]);
      assert.equal(second.cursor.offset, NodeFS.statSync(transcript.file).size);
    }),
  );

  it.effect("leaves out a record too large to read and reads the ones after it", () =>
    Effect.gen(function* () {
      using transcript = transcriptFile();
      const huge = record("big", text("assistant", "x".repeat(9 * 1024 * 1024)));
      NodeFS.writeFileSync(
        transcript.file,
        record("a1", text("user", "Assignment")) + huge + record("a3", text("assistant", "After.")),
      );
      const read = yield* readOmpSubagentTranscript(transcript.file, OMP_SUBAGENT_TRANSCRIPT_START);
      assert.deepEqual(
        read.steps.map((step) => step.kind),
        ["omitted", "text"],
      );
      assert.equal(read.cursor.offset, NodeFS.statSync(transcript.file).size);
    }),
  );
});
