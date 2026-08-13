import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import type { ExecutionProcessPort, ExecutionProcessRequest } from "@scientfactory/execution";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ScientLatexToolchainStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  GeneratedDocumentStore,
  layer as storeLayer,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import {
  LatexBuildService,
  type LatexBuildInput,
  layer as buildServiceLayer,
} from "./LatexBuildService.ts";
import { LatexToolchain } from "./LatexToolchain.ts";

/** Byte-for-byte the fixture shape the document store's own tests accept. */
function minimalPdf(marker: string): Uint8Array {
  const stream = `% ${marker}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

const authority = EnvironmentId.make("environment-scient-latex-test");
const serverEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(authority),
    getDescriptor: Effect.die("unused environment descriptor"),
  }),
);

const LATEXMK: ScientLatexToolchainStatus = {
  kind: "latexmk",
  executable: "latexmk",
  version: "4.79",
  probedAtEpochMs: 0,
};
const NO_TOOLCHAIN: ScientLatexToolchainStatus = {
  kind: null,
  executable: null,
  version: null,
  probedAtEpochMs: 0,
};

const TERMINAL_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

const SOURCE = "\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}\n";
const WARNING_TRANSCRIPT =
  "This is pdfTeX\nLaTeX Warning: Reference `fig:1' undefined on input line 12.\n";
const ERROR_TRANSCRIPT = "./main.tex:12: Undefined control sequence.\nl.12 \\nosuchmacro\n";

interface FakeCompile {
  readonly transcript: string;
  readonly exitCode: number;
  /** Written into the engine's `-outdir` just before the process exits. */
  readonly pdf: Uint8Array | null;
  /** When present the process only exits once the test resolves it. */
  readonly hold?: Deferred.Deferred<void>;
}

function outputDirectory(request: ExecutionProcessRequest): string {
  const flag = request.args.find((argument) => argument.startsWith("-outdir="));
  return flag === undefined ? "" : flag.slice("-outdir=".length);
}

/** Mirrors `buildLatexInvocation`'s own PDF path so the fake writes where the service looks. */
function producedPdfPath(request: ExecutionProcessRequest): string {
  const root = (request.args.at(-1) ?? "").replaceAll("\\", "/");
  const baseName = (root.split("/").at(-1) ?? root).replace(/\.\w+$/u, "");
  return `${outputDirectory(request)}/${baseName}.pdf`;
}

const makeHarness = (input: {
  readonly compiles: ReadonlyArray<FakeCompile>;
  readonly toolchain?: ScientLatexToolchainStatus;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "scient-latex-workspace-",
    });
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-state-" });
    yield* fileSystem.writeFileString(path.join(workspaceRoot, "main.tex"), SOURCE);

    const started = yield* Queue.unbounded<ExecutionProcessRequest>();
    const startCount = yield* Ref.make(0);
    const cancelCount = yield* Ref.make(0);
    const pending = yield* Ref.make<ReadonlyArray<FakeCompile>>(input.compiles);

    const port: ExecutionProcessPort = {
      start: (request) =>
        Effect.gen(function* () {
          const compile = yield* Ref.modify(pending, (compiles) => {
            const next = compiles[0];
            return next === undefined
              ? ([null, compiles] as const)
              : ([next, compiles.slice(1)] as const);
          });
          if (compile === null) return yield* Effect.die("the fake engine ran out of compiles");
          yield* Ref.update(startCount, (count) => count + 1);
          yield* Queue.offer(started, request);
          const exitSignal = yield* Deferred.make<number>();
          const finish = Effect.gen(function* () {
            if (compile.pdf !== null) {
              yield* fileSystem.makeDirectory(outputDirectory(request), { recursive: true });
              yield* fileSystem.writeFile(producedPdfPath(request), compile.pdf);
            }
            yield* Deferred.succeed(exitSignal, compile.exitCode);
          }).pipe(Effect.orDie);
          if (compile.hold === undefined) {
            yield* finish;
          } else {
            yield* Effect.forkScoped(Deferred.await(compile.hold).pipe(Effect.andThen(finish)));
          }
          return {
            output: Stream.make({ stream: "stdout" as const, text: compile.transcript }),
            exitCode: Deferred.await(exitSignal),
            cancel: Ref.update(cancelCount, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(exitSignal, 130)),
              Effect.asVoid,
            ),
          };
        }),
    };

    const serviceLayer = buildServiceLayer.pipe(
      Layer.provide(Layer.succeed(LocalExecutionProcess.ExecutionProcess, port)),
      Layer.provide(
        Layer.succeed(
          LatexToolchain,
          LatexToolchain.of({ probe: () => Effect.succeed(input.toolchain ?? LATEXMK) }),
        ),
      ),
      Layer.provideMerge(storeLayer.pipe(Layer.provide(serverEnvironment))),
      Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    return {
      serviceLayer,
      started,
      startCount,
      cancelCount,
      buildInput: { workspaceRoot, relativePath: "main.tex" } satisfies LatexBuildInput,
    };
  });

const awaitTerminal = (service: LatexBuildService["Service"], input: LatexBuildInput) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const snapshot = yield* service.status(input);
      if (TERMINAL_STATES.has(snapshot.state)) return snapshot;
      yield* Effect.sleep(Duration.millis(10));
    }
    return yield* service.status(input);
  });

describe("LatexBuildService", () => {
  it.live("publishes the produced PDF and keeps warnings from a successful compile", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        compiles: [{ transcript: WARNING_TRANSCRIPT, exitCode: 0, pdf: minimalPdf("build-a") }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        const queued = yield* service.requestBuild(harness.buildInput);
        expect(queued.rootRelativePath).toBe("main.tex");
        expect(queued.logicalDocumentKey.startsWith("latex:")).toBe(true);
        expect(queued.toolchain?.kind).toBe("latexmk");

        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.failureSummary).toBeNull();
        expect(finished.state).toBe("succeeded");
        expect(finished.pendingRerun).toBe(false);
        expect(finished.descriptor).toMatchObject({
          _tag: "generated-pdf",
          bindingStatus: "current",
          fileName: "main.pdf",
        });
        expect(finished.diagnostics).toEqual([
          {
            severity: "warning",
            file: null,
            line: 12,
            message: "Reference `fig:1' undefined on input line 12.",
          },
        ]);

        const bound = yield* store.getDescriptor(
          LogicalDocumentKey.make(finished.logicalDocumentKey),
        );
        expect(bound).toMatchObject({ bindingStatus: "current", bindingGeneration: 1 });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("marks the binding stale with parsed diagnostics when the engine exits non-zero", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        compiles: [
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-a") },
          { transcript: ERROR_TRANSCRIPT, exitCode: 1, pdf: null },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        const succeeded = yield* awaitTerminal(service, harness.buildInput);
        expect(succeeded.state).toBe("succeeded");
        const publishedRevision =
          succeeded.descriptor?._tag === "generated-pdf" ? succeeded.descriptor.revisionId : null;
        expect(publishedRevision).not.toBeNull();

        yield* service.requestBuild(harness.buildInput);
        const failed = yield* awaitTerminal(service, harness.buildInput);
        expect(failed.state).toBe("failed");
        expect(failed.diagnostics[0]).toMatchObject({
          severity: "error",
          file: "main.tex",
          line: 12,
        });
        expect(failed.failureSummary).toContain("main.tex:12:");
        // The last good PDF survives its failed successor, flagged stale.
        expect(failed.descriptor).toMatchObject({
          revisionId: publishedRevision,
          bindingStatus: "stale",
          staleReason: failed.failureSummary,
        });
        const bound = yield* store.getDescriptor(
          LogicalDocumentKey.make(failed.logicalDocumentKey),
        );
        expect(bound).toMatchObject({ bindingStatus: "stale", revisionId: publishedRevision });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("coalesces rebuilds requested while one is running into a single rerun", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-a"), hold },
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-b") },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);

        const second = yield* service.requestBuild(harness.buildInput);
        expect(second.pendingRerun).toBe(true);
        const third = yield* service.requestBuild(harness.buildInput);
        expect(third.pendingRerun).toBe(true);
        expect(yield* Ref.get(harness.startCount)).toBe(1);

        yield* Deferred.succeed(hold, undefined);
        yield* Queue.take(harness.started);
        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("succeeded");
        expect(finished.pendingRerun).toBe(false);
        // Three requests, two compiles: the second and third coalesced.
        expect(yield* Ref.get(harness.startCount)).toBe(2);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("cancels a running build through the process port without rerunning it", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [{ transcript: "", exitCode: 0, pdf: minimalPdf("build-a"), hold }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);

        const cancelled = yield* service.cancel(harness.buildInput);
        expect(cancelled.state).toBe("cancelled");
        expect(yield* Ref.get(harness.cancelCount)).toBe(1);

        const settled = yield* awaitTerminal(service, harness.buildInput);
        expect(settled.state).toBe("cancelled");
        expect(yield* Ref.get(harness.startCount)).toBe(1);
        // Cancelling again is a no-op rather than a second store transition.
        expect((yield* service.cancel(harness.buildInput)).state).toBe("cancelled");
        expect(yield* Ref.get(harness.cancelCount)).toBe(1);

        const bound = yield* store
          .getDescriptor(LogicalDocumentKey.make(settled.logicalDocumentKey))
          .pipe(Effect.flip);
        expect(bound.reason).toBe("missing-revision");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("lets the newest generation win and reports a superseded publish as cancelled", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-a") },
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-b") },
          { transcript: "", exitCode: 0, pdf: minimalPdf("build-c"), hold },
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        const first = yield* awaitTerminal(service, harness.buildInput);
        yield* Queue.take(harness.started);
        yield* service.requestBuild(harness.buildInput);
        const second = yield* awaitTerminal(service, harness.buildInput);
        yield* Queue.take(harness.started);
        expect(second.state).toBe("succeeded");
        expect(second.descriptor).toMatchObject({ bindingGeneration: 2 });
        const firstRevision =
          first.descriptor?._tag === "generated-pdf" ? first.descriptor.revisionId : null;
        const secondRevision =
          second.descriptor?._tag === "generated-pdf" ? second.descriptor.revisionId : null;
        expect(secondRevision).not.toBe(firstRevision);

        const documentKey = LogicalDocumentKey.make(second.logicalDocumentKey);
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);
        // A different producer takes the binding while the third build compiles.
        yield* store.beginProduction({
          logicalDocumentKey: documentKey,
          operationId: ProducingOperationId.make("external-production"),
          producerId: ArtifactProducerId.make("latex"),
        });
        yield* Deferred.succeed(hold, undefined);

        const superseded = yield* awaitTerminal(service, harness.buildInput);
        expect(superseded.state).toBe("cancelled");
        const bound = yield* store.getDescriptor(documentKey);
        expect(bound).toMatchObject({ revisionId: secondRevision });
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("fails without touching the document store when no toolchain is installed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ compiles: [], toolchain: NO_TOOLCHAIN });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const store = yield* GeneratedDocumentStore;
        yield* service.requestBuild(harness.buildInput);
        const finished = yield* awaitTerminal(service, harness.buildInput);
        expect(finished.state).toBe("failed");
        expect(finished.failureSummary).toContain("No LaTeX toolchain found");
        expect(finished.descriptor).toBeNull();
        expect(yield* Ref.get(harness.startCount)).toBe(0);

        const bound = yield* store
          .getDescriptor(LogicalDocumentKey.make(finished.logicalDocumentKey))
          .pipe(Effect.flip);
        expect(bound.reason).toBe("missing-binding");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reports an unreadable source without starting a build", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ compiles: [] });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        const missing = yield* service.requestBuild({
          workspaceRoot: harness.buildInput.workspaceRoot,
          relativePath: "absent.tex",
        });
        expect(missing.state).toBe("failed");
        expect(missing.failureSummary).toContain("absent.tex");
        expect(yield* Ref.get(harness.startCount)).toBe(0);

        const escaping = yield* service
          .requestBuild({
            workspaceRoot: harness.buildInput.workspaceRoot,
            relativePath: "../outside.tex",
          })
          .pipe(Effect.flip);
        expect(escaping.reason).toBe("invalid-path");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails a build whose engine never exits once the compile timeout elapses", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        compiles: [{ transcript: "", exitCode: 0, pdf: null, hold }],
      });
      yield* Effect.gen(function* () {
        const service = yield* LatexBuildService;
        yield* service.requestBuild(harness.buildInput);
        yield* Queue.take(harness.started);

        yield* TestClock.adjust(Duration.minutes(5));
        let snapshot = yield* service.status(harness.buildInput);
        for (let attempt = 0; attempt < 100 && !TERMINAL_STATES.has(snapshot.state); attempt += 1) {
          yield* TestClock.adjust(Duration.millis(20));
          snapshot = yield* service.status(harness.buildInput);
        }
        expect(snapshot.state).toBe("failed");
        expect(snapshot.failureSummary).toBe("Build timed out.");
        expect(yield* Ref.get(harness.cancelCount)).toBe(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())), Effect.scoped),
  );
});
