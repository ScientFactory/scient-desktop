import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ExecutionRunId, type ExecutionProcessRequest } from "./contract.ts";
import { createSimulatedExecutionPort } from "./simulator.ts";
import { transitionExecutionStatus } from "./stateMachine.ts";

interface FakeDocumentBuild {
  readonly buildId: string;
  readonly root: string;
  readonly source: string;
  readonly engine: string;
}

function prepareFakeDocumentBuild(build: FakeDocumentBuild): ExecutionProcessRequest {
  return {
    runId: ExecutionRunId.make(build.buildId),
    executable: build.engine,
    args: [build.source],
    cwd: build.root,
    environment: {},
  };
}

describe("document build execution boundary", () => {
  it.effect("drives a typesetting build without analysis-domain contracts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const port = createSimulatedExecutionPort((request) => {
          expect(request).toMatchObject({
            executable: "tectonic",
            args: ["paper.tex"],
            cwd: "/manuscript",
          });
          return {
            steps: [{ output: { stream: "stdout", text: "paper.pdf\n" } }],
            exitCode: 0,
          };
        });
        const handle = yield* port.start(
          prepareFakeDocumentBuild({
            buildId: "build-1",
            root: "/manuscript",
            source: "paper.tex",
            engine: "tectonic",
          }),
        );
        let status = transitionExecutionStatus("queued", "starting");
        status = transitionExecutionStatus(status, "running");
        const output = yield* Stream.runCollect(handle.output);
        status = transitionExecutionStatus(
          status,
          (yield* handle.exitCode) === 0 ? "succeeded" : "failed",
        );

        expect(status).toBe("succeeded");
        expect(output).toEqual([{ stream: "stdout", text: "paper.pdf\n" }]);
      }),
    ),
  );
});
