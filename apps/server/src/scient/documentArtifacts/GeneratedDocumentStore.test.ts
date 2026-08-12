import {
  ArtifactAuthority,
  ArtifactProducerId,
  BindingGeneration,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { GeneratedDocumentStore, layer } from "./GeneratedDocumentStore.ts";

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

const authority = EnvironmentId.make("environment-document-artifacts-test");
const serverEnvironment = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(authority),
    getDescriptor: Effect.die("unused environment descriptor"),
  }),
);

const makeStoreLayer = (configLayer: ReturnType<typeof ServerConfig.ServerConfig.layerTest>) =>
  layer.pipe(Layer.provide(serverEnvironment), Layer.provide(configLayer));

const logicalDocumentKey = LogicalDocumentKey.make("latex:/workspace/paper/main.tex");
const producerId = ArtifactProducerId.make("latex");

const operation = (generation: number) => ({
  logicalDocumentKey,
  operationId: ProducingOperationId.make(`build-${generation}`),
  producerId,
});

describe("GeneratedDocumentStore", () => {
  it.effect("publishes immutable revisions and preserves the last success after failure", () =>
    Effect.gen(function* () {
      const store = yield* GeneratedDocumentStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const productionA = yield* store.beginProduction(operation(1));
      expect(productionA.generation).toBe(BindingGeneration.make(1));
      const descriptorA = yield* store.publishPdf({
        ...productionA,
        bytes: minimalPdf("revision-a"),
        title: "Research paper",
        provenanceKind: "document-build",
      });
      expect(descriptorA).toMatchObject({
        _tag: "generated-pdf",
        authority: ArtifactAuthority.make(authority),
        bindingGeneration: 1,
        bindingStatus: "current",
        fileName: "Research paper.pdf",
      });
      if (descriptorA._tag !== "generated-pdf") throw new Error("expected generated source");
      const revisionA = yield* store.resolveRevision(descriptorA);
      expect((yield* fileSystem.readDirectory(path.dirname(revisionA.path))).toSorted()).toEqual([
        "document.pdf",
        "metadata.json",
      ]);

      const productionB = yield* store.beginProduction(operation(2));
      expect(productionB.generation).toBe(BindingGeneration.make(2));
      const whileRebuilding = yield* store.getDescriptor(logicalDocumentKey);
      expect(whileRebuilding).toMatchObject({
        revisionId: descriptorA.revisionId,
        bindingGeneration: 2,
        bindingStatus: "current",
      });
      const descriptorB = yield* store.publishPdf({
        ...productionB,
        bytes: minimalPdf("revision-b"),
        title: "Research paper",
        provenanceKind: "document-build",
      });
      expect(descriptorB).toMatchObject({
        _tag: "generated-pdf",
        bindingGeneration: 2,
        bindingStatus: "current",
      });
      if (descriptorB._tag !== "generated-pdf") throw new Error("expected generated source");
      expect(descriptorB.revisionId).not.toBe(descriptorA.revisionId);

      const productionC = yield* store.beginProduction(operation(3));
      yield* store.failProduction({ ...productionC, reason: "LaTeX compilation failed." });
      const stale = yield* store.getDescriptor(logicalDocumentKey);
      expect(stale).toMatchObject({
        _tag: "generated-pdf",
        revisionId: descriptorB.revisionId,
        bindingGeneration: 3,
        bindingStatus: "stale",
        staleReason: "LaTeX compilation failed.",
      });
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-document-store-lifecycle-",
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

  it.effect(
    "rejects corrupt output and late completions without replacing the active revision",
    () =>
      Effect.gen(function* () {
        const store = yield* GeneratedDocumentStore;
        const productionA = yield* store.beginProduction(operation(1));
        const descriptorA = yield* store.publishPdf({
          ...productionA,
          bytes: minimalPdf("revision-a"),
          title: "Paper",
          provenanceKind: "document-build",
        });
        if (descriptorA._tag !== "generated-pdf") throw new Error("expected generated source");

        const productionB = yield* store.beginProduction(operation(2));
        const productionC = yield* store.beginProduction(operation(3));
        const late = yield* store
          .publishPdf({
            ...productionB,
            bytes: minimalPdf("late-revision"),
            title: "Paper",
            provenanceKind: "document-build",
          })
          .pipe(Effect.flip);
        expect(late.reason).toBe("superseded");

        const wrongProducer = yield* store
          .publishPdf({
            ...productionC,
            producerId: ArtifactProducerId.make("another-producer"),
            bytes: new TextEncoder().encode("not a PDF"),
            title: "Paper",
            provenanceKind: "document-build",
          })
          .pipe(Effect.flip);
        expect(wrongProducer.reason).toBe("superseded");

        const rejected = yield* store
          .publishPdf({
            ...productionC,
            bytes: new TextEncoder().encode("not a PDF"),
            title: "Paper",
            provenanceKind: "document-build",
          })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("validation-rejected");
        const stale = yield* store.getDescriptor(logicalDocumentKey);
        expect(stale).toMatchObject({
          revisionId: descriptorA.revisionId,
          bindingStatus: "stale",
        });
      }).pipe(
        Effect.provide(
          makeStoreLayer(
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "scient-document-store-supersession-",
            }),
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Effect.scoped,
      ),
  );

  it.effect(
    "persists bindings across store lifetimes and detects authority or byte tampering",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-document-store-restart-",
        });
        const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir);
        const storeLayer = makeStoreLayer(configLayer);

        const descriptor = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* GeneratedDocumentStore;
            const production = yield* store.beginProduction(operation(1));
            return yield* store.publishPdf({
              ...production,
              bytes: minimalPdf("persistent"),
              title: "Persistent paper",
              provenanceKind: "document-build",
            });
          }).pipe(Effect.provide(storeLayer)),
        );
        if (descriptor._tag !== "generated-pdf") throw new Error("expected generated source");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* GeneratedDocumentStore;
            expect(yield* store.getDescriptor(logicalDocumentKey)).toEqual(descriptor);
            const restartedProduction = yield* store.beginProduction(operation(2));
            expect(restartedProduction.generation).toBe(BindingGeneration.make(2));
            yield* store.failProduction({
              ...restartedProduction,
              reason: "Stopped after restart-generation check.",
            });
            const mismatch = yield* store
              .resolveRevision({
                authority: ArtifactAuthority.make("another-environment"),
                artifactId: descriptor.artifactId,
                revisionId: descriptor.revisionId,
              })
              .pipe(Effect.flip);
            expect(mismatch.reason).toBe("authority-mismatch");

            const resolved = yield* store.resolveRevision(descriptor);
            const original = yield* fileSystem.readFile(resolved.path);
            const changed = original.slice();
            changed[changed.length - 1] = changed[changed.length - 1] === 0 ? 1 : 0;
            yield* fileSystem.writeFile(resolved.path, changed);
            const tampered = yield* store.resolveRevision(descriptor).pipe(Effect.flip);
            expect(tampered.reason).toBe("corrupt-state");
          }).pipe(Effect.provide(storeLayer)),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
