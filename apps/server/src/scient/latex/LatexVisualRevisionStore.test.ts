import { ArtifactId, ArtifactRevisionId } from "@scientfactory/document-artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  GeneratedDocumentStore,
  GeneratedDocumentStoreError,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import {
  LatexVisualRevisionStore,
  layer as visualRevisionStoreLayer,
} from "./LatexVisualRevisionStore.ts";

const environmentId = EnvironmentId.make("environment-latex-visual-revision-test");
const artifactId = ArtifactId.make("artifact-latex-visual-revision-test");
const firstRevisionId = ArtifactRevisionId.make("revision-latex-visual-first");
const secondRevisionId = ArtifactRevisionId.make("revision-latex-visual-second");
const workspaceRoot = "/workspace";

const revisionKey = (revisionId: ArtifactRevisionId) => `${artifactId}/${revisionId}`;

const makeHarness = Effect.gen(function* () {
  const attachments = yield* Ref.make(new Map<string, Uint8Array>());
  const revisionReadFails = yield* Ref.make(false);
  const store = GeneratedDocumentStore.of({
    beginProduction: () => Effect.die("unused"),
    publishPdf: () => Effect.die("unused"),
    failProduction: () => Effect.die("unused"),
    abandonProduction: () => Effect.die("unused"),
    getDescriptor: () => Effect.die("unused"),
    resolveRevision: () => Effect.die("unused"),
    revisionExists: () => Effect.die("unused"),
    readRevisionAttachment: (input) =>
      Effect.gen(function* () {
        if (yield* Ref.get(revisionReadFails)) {
          return yield* new GeneratedDocumentStoreError({
            operation: "read-revision",
            reason: "filesystem",
            detail: "transient attachment read failure",
          });
        }
        return (yield* Ref.get(attachments)).get(revisionKey(input.revisionId)) ?? null;
      }),
    resolveRevisionForAsset: () => Effect.die("unused"),
    retainRevision: () => Effect.void,
    changes: Stream.empty,
  });
  const serverEnvironment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused"),
  });
  const serviceLayer = visualRevisionStoreLayer.pipe(
    Layer.provide(Layer.succeed(GeneratedDocumentStore, store)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, serverEnvironment)),
    Layer.provideMerge(NodeServices.layer),
  );
  return { attachments, revisionReadFails, serviceLayer };
});

const sourceRevisions = {
  "main.tex": `sha256:${"a".repeat(64)}`,
  "chapters/body.tex": `sha256:${"b".repeat(64)}`,
};

const ref = (revisionId: ArtifactRevisionId = firstRevisionId) => ({
  artifactId,
  revisionId,
  workspaceRoot,
  rootRelativePath: "main.tex",
});

describe("LatexVisualRevisionStore", () => {
  it.effect("loads only revision-attached evidence with the exact workspace identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* LatexVisualRevisionStore;
        const attachment = yield* service.prepare({
          workspaceRoot,
          rootRelativePath: "main.tex",
          sourceRevisions,
        });
        yield* Ref.update(harness.attachments, (current) =>
          new Map(current).set(revisionKey(firstRevisionId), attachment.bytes),
        );

        expect(yield* service.load(ref())).toEqual(sourceRevisions);
        expect(yield* service.load({ ...ref(), workspaceRoot: "/other" })).toBeNull();
        expect(yield* service.load({ ...ref(), rootRelativePath: "other.tex" })).toBeNull();
        expect(yield* service.load(ref(secondRevisionId))).toBeNull();
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails closed on corrupt or missing revision attachments", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* LatexVisualRevisionStore;
        yield* Ref.update(harness.attachments, (current) =>
          new Map(current).set(revisionKey(firstRevisionId), new TextEncoder().encode("{broken")),
        );
        expect(yield* service.load(ref())).toBeNull();
        yield* Ref.set(harness.attachments, new Map());
        expect(yield* service.load(ref())).toBeNull();
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports invalid source revision input as a typed encoding failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* LatexVisualRevisionStore;
        const outcome = yield* Effect.exit(
          service.prepare({
            workspaceRoot,
            rootRelativePath: "main.tex",
            sourceRevisions: { "main.tex": "not-a-source-digest" },
          }),
        );
        expect(outcome._tag).toBe("Failure");
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("fails closed transiently without destroying retained evidence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* LatexVisualRevisionStore;
        const attachment = yield* service.prepare({
          workspaceRoot,
          rootRelativePath: "main.tex",
          sourceRevisions,
        });
        yield* Ref.update(harness.attachments, (current) =>
          new Map(current).set(revisionKey(firstRevisionId), attachment.bytes),
        );
        yield* Ref.set(harness.revisionReadFails, true);
        expect(yield* service.load(ref())).toBeNull();
        expect(yield* Ref.get(harness.attachments)).toHaveLength(1);
        yield* Ref.set(harness.revisionReadFails, false);
        expect(yield* service.load(ref())).toEqual(sourceRevisions);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
