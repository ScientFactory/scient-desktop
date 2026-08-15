import {
  ArtifactAuthority,
  ArtifactProducerId,
  BindingGeneration,
  LogicalDocumentKey,
  ProducingOperationId,
  type PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ASSET_TOKEN_TTL_MS } from "../../assets/AssetLifetime.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  GeneratedDocumentStore,
  layer,
  layerWith,
  type GeneratedDocumentRetentionPolicy,
} from "./GeneratedDocumentStore.ts";

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

const makeStoreLayer = (
  configLayer: ReturnType<typeof ServerConfig.ServerConfig.layerTest>,
  retention?: Partial<GeneratedDocumentRetentionPolicy>,
) =>
  (retention === undefined ? layer : layerWith({ retention })).pipe(
    Layer.provide(serverEnvironment),
    Layer.provide(configLayer),
  );

const generatedSource = (descriptor: PdfSourceDescriptor) => {
  if (descriptor._tag !== "generated-pdf") throw new Error("expected a generated source");
  return descriptor;
};

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

const publishRevision = (
  store: GeneratedDocumentStore["Service"],
  generation: number,
  marker: string,
  documentKey: LogicalDocumentKey = logicalDocumentKey,
) =>
  Effect.gen(function* () {
    const production = yield* store.beginProduction({
      logicalDocumentKey: documentKey,
      operationId: ProducingOperationId.make(`build-${marker}`),
      producerId,
    });
    expect(production.generation).toBe(BindingGeneration.make(generation));
    return generatedSource(
      yield* store.publishPdf({
        ...production,
        bytes: minimalPdf(marker),
        title: "Paper",
        provenanceKind: "document-build",
      }),
    );
  });

const expectEvicted = (
  store: GeneratedDocumentStore["Service"],
  descriptor: ReturnType<typeof generatedSource>,
) =>
  store.resolveRevision(descriptor).pipe(
    Effect.flip,
    Effect.map((error) => expect(error.reason).toBe("missing-revision")),
  );

// Markers of equal length keep every fixture revision byte-identical in size, so
// a byte budget can be expressed as a multiple of one revision.
const REVISION_BYTES = minimalPdf("revision-a").byteLength;

describe("GeneratedDocumentStore retention", () => {
  it.effect("evicts the oldest superseded revisions and never the current one", () =>
    Effect.gen(function* () {
      const store = yield* GeneratedDocumentStore;
      const first = yield* publishRevision(store, 1, "revision-a");
      const second = yield* publishRevision(store, 2, "revision-b");
      const third = yield* publishRevision(store, 3, "revision-c");
      const fourth = yield* publishRevision(store, 4, "revision-d");

      yield* expectEvicted(store, first);
      yield* expectEvicted(store, second);
      expect((yield* store.resolveRevision(third)).artifact.revisionId).toBe(third.revisionId);
      expect((yield* store.resolveRevision(fourth)).artifact.revisionId).toBe(fourth.revisionId);
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        revisionId: fourth.revisionId,
        bindingStatus: "current",
      });
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-document-store-retention-count-",
          }),
          { maxRevisionCount: 2 },
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

  it.effect("evicts against the byte budget across every logical document", () =>
    Effect.gen(function* () {
      const store = yield* GeneratedDocumentStore;
      const otherDocumentKey = LogicalDocumentKey.make("latex:/workspace/paper/appendix.tex");
      const first = yield* publishRevision(store, 1, "revision-a");
      const second = yield* publishRevision(store, 2, "revision-b");
      // A second document's first publish pushes total bytes past the budget, so
      // the oldest superseded revision of the first document funds it.
      const other = yield* publishRevision(store, 1, "revision-c", otherDocumentKey);

      yield* expectEvicted(store, first);
      expect((yield* store.resolveRevision(second)).artifact.revisionId).toBe(second.revisionId);
      expect((yield* store.resolveRevision(other)).artifact.revisionId).toBe(other.revisionId);
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        revisionId: second.revisionId,
        bindingStatus: "current",
      });
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-document-store-retention-bytes-",
          }),
          { maxTotalBytes: REVISION_BYTES * 2 },
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

  it.effect("never evicts a revision retained by in-flight work", () =>
    Effect.gen(function* () {
      const store = yield* GeneratedDocumentStore;
      const first = yield* publishRevision(store, 1, "revision-a");
      const second = yield* publishRevision(store, 2, "revision-b");

      const third = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* store.retainRevision(first);
          const published = yield* publishRevision(store, 3, "revision-c");
          // The retained revision is protected, so the budget is funded by the
          // unprotected superseded revision instead.
          expect((yield* store.resolveRevision(first)).artifact.revisionId).toBe(first.revisionId);
          yield* expectEvicted(store, second);
          return published;
        }),
      );

      // Protection lasts exactly as long as the scope that acquired it.
      const fourth = yield* publishRevision(store, 4, "revision-d");
      yield* expectEvicted(store, first);
      expect((yield* store.resolveRevision(third)).artifact.revisionId).toBe(third.revisionId);
      expect((yield* store.resolveRevision(fourth)).artifact.revisionId).toBe(fourth.revisionId);
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-document-store-retention-pinned-",
          }),
          { maxRevisionCount: 2 },
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

  it.effect("persists reader leases across a restart until the signed URL expires", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-document-store-reader-lease-",
      });
      const storeLayer = makeStoreLayer(
        ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir),
        { maxRevisionCount: 2 },
      );

      const { first, second } = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          const first = yield* publishRevision(store, 1, "revision-a");
          const second = yield* publishRevision(store, 2, "revision-b");
          const retained = yield* store.resolveRevisionForAsset(first);
          expect(retained.document.artifact.revisionId).toBe(first.revisionId);
          expect(retained.expiresAtEpochMs).toBeGreaterThan(0);
          return { first, second };
        }).pipe(Effect.provide(storeLayer)),
      );

      // A new process reconstructs protection from the durable index. Publishing
      // a third revision must evict the other superseded revision, never bytes
      // an already-issued reader URL is still allowed to request.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          const third = yield* publishRevision(store, 3, "revision-c");
          expect((yield* store.resolveRevision(first)).artifact.revisionId).toBe(first.revisionId);
          yield* expectEvicted(store, second);
          expect((yield* store.resolveRevision(third)).artifact.revisionId).toBe(third.revisionId);

          yield* TestClock.adjust(Duration.millis(ASSET_TOKEN_TTL_MS + 1));
          const fourth = yield* publishRevision(store, 4, "revision-d");
          yield* expectEvicted(store, first);
          expect((yield* store.resolveRevision(fourth)).artifact.revisionId).toBe(
            fourth.revisionId,
          );
        }).pipe(Effect.provide(storeLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("tolerates revision directories a crashed eviction already removed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-document-store-retention-crash-",
      });
      const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir);
      const storeLayer = makeStoreLayer(configLayer, { maxRevisionCount: 2 });

      const orphanDirectory = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          const first = yield* publishRevision(store, 1, "revision-a");
          const second = yield* publishRevision(store, 2, "revision-b");
          const firstDirectory = path.dirname((yield* store.resolveRevision(first)).path);

          // Simulate a crash between the index write and the directory delete.
          yield* fileSystem.remove(firstDirectory, { recursive: true });
          const third = yield* publishRevision(store, 3, "revision-c");
          yield* expectEvicted(store, first);
          expect((yield* store.resolveRevision(third)).artifact.revisionId).toBe(third.revisionId);

          // A directory nothing references survives only until the next sweep.
          const orphan = path.join(
            path.dirname(path.dirname(path.dirname((yield* store.resolveRevision(second)).path))),
            "00000000-orphan-artifact",
            "00000000-orphan-revision",
          );
          yield* fileSystem.makeDirectory(orphan, { recursive: true });
          return orphan;
        }).pipe(Effect.provide(storeLayer)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          expect(yield* fileSystem.exists(orphanDirectory)).toBe(false);
          expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
            bindingStatus: "current",
          });
        }).pipe(Effect.provide(storeLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps a referenced revision when a binding cannot be read during the sweep", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-document-store-unreadable-binding-",
      });
      const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir);
      const storeLayer = makeStoreLayer(configLayer);

      const revisionDirectory = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          const published = yield* publishRevision(store, 1, "revision-a");
          return path.dirname((yield* store.resolveRevision(published)).path);
        }).pipe(Effect.provide(storeLayer)),
      );

      // .../document-artifacts/revisions/<artifactId>/<revisionId>
      const artifactsDirectory = path.dirname(path.dirname(path.dirname(revisionDirectory)));
      const bindingsDirectory = path.join(artifactsDirectory, "bindings");
      // Both halves of the evidence are damaged at once: the binding can no
      // longer say which revision it protects, and the index that would have
      // covered for it is gone. The revision is referenced all the same.
      for (const fileName of yield* fileSystem.readDirectory(bindingsDirectory)) {
        yield* fileSystem.writeFileString(
          path.join(bindingsDirectory, fileName),
          "{ not a binding",
        );
      }
      yield* fileSystem.remove(path.join(artifactsDirectory, "retention-index.json"), {
        force: true,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          expect(yield* fileSystem.exists(revisionDirectory)).toBe(true);
          expect(yield* fileSystem.exists(path.join(revisionDirectory, "document.pdf"))).toBe(true);
          // Nothing was papered over either: the binding is still unreadable.
          expect((yield* store.getDescriptor(logicalDocumentKey).pipe(Effect.flip)).reason).toBe(
            "corrupt-state",
          );
        }).pipe(Effect.provide(storeLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("GeneratedDocumentStore production lifecycle", () => {
  it.effect("abandons a production without staling the published revision", () =>
    Effect.gen(function* () {
      const store = yield* GeneratedDocumentStore;
      const published = yield* publishRevision(store, 1, "revision-a");

      const cancelled = yield* store.beginProduction(operation(2));
      const released = yield* store.abandonProduction({
        ...cancelled,
        reason: "The requester cancelled this build.",
      });
      expect(released).toMatchObject({
        status: "current",
        staleReason: null,
        latestAttempt: { state: "abandoned" },
      });
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        revisionId: published.revisionId,
        bindingStatus: "current",
        staleReason: null,
      });

      // Idempotent: a handle that no longer owns the binding settles as a no-op.
      expect(
        yield* store.abandonProduction({ ...cancelled, reason: "Cancelled again." }),
      ).toMatchObject({ status: "current", generation: BindingGeneration.make(2) });

      const superseded = yield* store.beginProduction(operation(3));
      yield* store.beginProduction(operation(4));
      expect(
        yield* store.abandonProduction({ ...superseded, reason: "Superseded by a newer build." }),
      ).toMatchObject({ generation: BindingGeneration.make(4), status: "current" });

      // Discrediting the inputs still stales, so the two paths stay distinct.
      const failing = yield* store.beginProduction(operation(5));
      yield* store.failProduction({ ...failing, reason: "LaTeX compilation failed." });
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        bindingStatus: "stale",
        staleReason: "LaTeX compilation failed.",
      });
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-document-store-abandon-",
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

  it.effect("keeps a discredited revision stale through a cancelled retry", () =>
    Effect.gen(function* () {
      const store = yield* GeneratedDocumentStore;
      const published = yield* publishRevision(store, 1, "revision-a");

      const failing = yield* store.beginProduction(operation(2));
      yield* store.failProduction({ ...failing, reason: "LaTeX compilation failed." });
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        bindingStatus: "stale",
        staleReason: "LaTeX compilation failed.",
      });

      // Starting a retry is not evidence that the PDF caught up with its
      // sources, so the reader keeps seeing the stale revision and the reason.
      const retry = yield* store.beginProduction(operation(3));
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        revisionId: published.revisionId,
        bindingGeneration: 3,
        bindingStatus: "stale",
        staleReason: "LaTeX compilation failed.",
      });

      // Cancelling the retry restores the condition the binding held before it,
      // rather than laundering the discredited revision into `current`.
      expect(
        yield* store.abandonProduction({ ...retry, reason: "The requester cancelled this build." }),
      ).toMatchObject({
        status: "stale",
        staleReason: "LaTeX compilation failed.",
        latestAttempt: { state: "abandoned", failureReason: "The requester cancelled this build." },
      });
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        revisionId: published.revisionId,
        bindingStatus: "stale",
        staleReason: "LaTeX compilation failed.",
      });

      // Only a published revision earns `current` back.
      const succeeding = yield* store.beginProduction(operation(4));
      const republished = generatedSource(
        yield* store.publishPdf({
          ...succeeding,
          bytes: minimalPdf("revision-b"),
          title: "Paper",
          provenanceKind: "document-build",
        }),
      );
      expect(republished.revisionId).not.toBe(published.revisionId);
      expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
        revisionId: republished.revisionId,
        bindingStatus: "current",
        staleReason: null,
      });
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-document-store-stale-retry-",
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

  it.effect("reconciles productions interrupted by a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-document-store-reconcile-",
      });
      const storeLayer = makeStoreLayer(
        ServerConfig.ServerConfig.layerTest(process.cwd(), baseDir),
      );
      const neverPublishedKey = LogicalDocumentKey.make("latex:/workspace/paper/draft.tex");

      const published = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          const descriptor = yield* publishRevision(store, 1, "revision-a");
          // Both productions are left running: the store lifetime ends the way a
          // crashed or restarted server ends it.
          yield* store.beginProduction(operation(2));
          yield* store.beginProduction({
            logicalDocumentKey: neverPublishedKey,
            operationId: ProducingOperationId.make("build-draft"),
            producerId,
          });
          return descriptor;
        }).pipe(Effect.provide(storeLayer)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GeneratedDocumentStore;
          // The interrupted rebuild is released, not failed: its revision stays
          // current rather than being wrongly marked stale.
          expect(yield* store.getDescriptor(logicalDocumentKey)).toMatchObject({
            revisionId: published.revisionId,
            bindingGeneration: 2,
            bindingStatus: "current",
            staleReason: null,
          });
          expect((yield* store.getDescriptor(neverPublishedKey).pipe(Effect.flip)).reason).toBe(
            "missing-revision",
          );

          const reconciled = yield* store.changes.pipe(
            Stream.filter((change) => change.changeKind === "reconcile"),
            Stream.take(2),
            Stream.runCollect,
          );
          expect(
            Array.from(reconciled, (change) => [
              change.logicalDocumentKey,
              change.status,
            ]).toSorted(),
          ).toEqual(
            [
              [logicalDocumentKey, "current"],
              [neverPublishedKey, "unbound"],
            ].toSorted(),
          );

          // Generations stay monotonic across the interruption.
          expect((yield* store.beginProduction(operation(3))).generation).toBe(
            BindingGeneration.make(3),
          );
        }).pipe(Effect.provide(storeLayer)),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("announces every binding transition on the change seam", () =>
    Effect.gen(function* () {
      const store = yield* GeneratedDocumentStore;
      const observed = yield* store.changes.pipe(
        Stream.take(7),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const published = yield* publishRevision(store, 1, "revision-a");
      const cancelled = yield* store.beginProduction(operation(2));
      yield* store.abandonProduction({ ...cancelled, reason: "Cancelled." });
      const stale = yield* store.beginProduction(operation(3));
      yield* store.failProduction({ ...stale, reason: "Compilation failed." });
      // Abandoning an attempt that already settled reports the supersession
      // rather than changing the binding.
      yield* store.abandonProduction({ ...stale, reason: "Cancelled after failing." });

      const expectedKinds = ["begin", "publish", "begin", "abandon", "begin", "fail", "supersede"];
      const live = Array.from(yield* Fiber.join(observed));
      expect(live.map((change) => change.changeKind)).toEqual(expectedKinds);
      expect(live[1]).toMatchObject({
        logicalDocumentKey,
        generation: BindingGeneration.make(1),
        status: "current",
        activeRevision: { artifactId: published.artifactId, revisionId: published.revisionId },
      });

      // A consumer that attaches later still observes the recent history.
      const replayed = yield* store.changes.pipe(Stream.take(7), Stream.runCollect);
      expect(Array.from(replayed, (change) => change.changeKind)).toEqual(expectedKinds);
    }).pipe(
      Effect.provide(
        makeStoreLayer(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-document-store-changes-",
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );
});
