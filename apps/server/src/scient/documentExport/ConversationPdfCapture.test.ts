// @effect-diagnostics nodeBuiltinImport:off -- Tests read the real capture directory.
import * as NodeFSP from "node:fs/promises";

import { ScientDocumentPageInput, ThreadId, type DocumentBundle } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAsset } from "../../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import { GeneratedDocumentStore } from "../documentArtifacts/GeneratedDocumentStore.ts";
import { captureConversationBundle } from "./ConversationPdfCapture.ts";
import { sha256Digest } from "./DocumentCapture.ts";
import {
  documentExportTestLayer,
  makeGeneratedDocumentStore,
  renderResultFor,
} from "./DocumentExportTestUtils.ts";
import { publishCapturedDocumentPdf } from "./DocumentPdfPublication.ts";

const layer = Layer.orDie(documentExportTestLayer("scient-conversation-pdf-test-"));
const decodePageInput = Schema.decodeUnknownSync(Schema.fromJsonString(ScientDocumentPageInput));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const digest = sha256Digest(new TextEncoder().encode("conversation snapshot"));

const bundle: DocumentBundle = {
  markdown: [
    "# Export design",
    "",
    "## You · 27 Sep 2026, 14:05",
    "",
    "Please look at this plot:\\",
    "![plot.png](scient-asset:att-1)",
    "",
    "## Assistant · 27 Sep 2026, 14:06",
    "",
    "<details>\n<summary>Work log · 2 steps</summary>\n\nRan tests.\n\n</details>",
    "",
    "Attached: [results.csv](scient-asset:att-2)",
  ].join("\n"),
  profile: "chat",
  metadata: {
    title: "Export design",
    language: null,
    direction: "auto",
    createdAt: "2026-09-27T14:05:00.000Z",
    source: {
      _tag: "conversation",
      threadId: ThreadId.make("thread-export"),
      contentDigest: digest,
      snapshotSequence: 42,
    },
  },
  assets: [
    {
      id: "att-1",
      role: "image",
      fileName: "plot.png",
      mediaType: "image/png",
      byteLength: PNG.byteLength,
      packagePath: "attachments/01-plot.png",
      content: { _tag: "bytes", bytes: PNG, sha256: sha256Digest(PNG) },
    },
    {
      id: "att-2",
      role: "attachment",
      fileName: "results.csv",
      mediaType: "text/csv",
      byteLength: 5,
      packagePath: "attachments/02-results.csv",
      content: { _tag: "bytes", bytes: new TextEncoder().encode("a,b\n"), sha256: digest },
    },
    {
      id: "att-3",
      role: "rendered-diagram",
      fileName: "diagram.png",
      mediaType: "image/png",
      byteLength: PNG.byteLength,
      packagePath: "attachments/03-diagram.png",
      content: { _tag: "bytes", bytes: PNG, sha256: sha256Digest(PNG) },
    },
  ],
  citations: [],
  warnings: [{ code: "running-turn-omitted", message: "The running turn was left out." }],
};

const readCaptured = (inputRelativeUrl: string, file: string) =>
  Effect.gen(function* () {
    const token = inputRelativeUrl.split("/")[3]!;
    const asset = yield* resolveAsset(token, file).pipe(
      Effect.provideService(
        NativeAppIconResolver.NativeAppIconResolver,
        NativeAppIconResolver.NativeAppIconResolver.of({
          resolve: () => Effect.succeed(null),
        } as unknown as NativeAppIconResolver.NativeAppIconResolver["Service"]),
      ),
    );
    if (asset === null || asset.kind !== "file") return null;
    return yield* Effect.promise(() => NodeFSP.readFile(asset.path));
  });

describe("conversation PDF capture", () => {
  it.effect("captures a chat bundle through the same page input and publication", () =>
    Effect.gen(function* () {
      const prepared = yield* captureConversationBundle(bundle);
      expect(prepared).toMatchObject({
        title: "Export design",
        expected: { documentKind: "conversation", sourceDigest: digest },
        warnings: bundle.warnings,
      });
      const input = decodePageInput(
        new TextDecoder().decode(
          (yield* readCaptured(prepared.inputRelativeUrl, "document.json"))!,
        ),
      );
      expect(input).toMatchObject({
        profile: "chat",
        documentKind: "conversation",
        markdown: bundle.markdown,
        createdAt: "2026-09-27T14:05:00.000Z",
      });
      // Only referenced assets travel; attachments print as names, not bytes.
      expect(input.assets).toEqual([
        {
          id: "att-1",
          role: "image",
          fileName: "plot.png",
          mediaType: "image/png",
          content: { _tag: "captured", path: "assets/0001.png", sha256: sha256Digest(PNG) },
        },
        {
          id: "att-2",
          role: "attachment",
          fileName: "results.csv",
          mediaType: "text/csv",
          content: { _tag: "unavailable", reason: "unsupported" },
        },
      ]);
      expect(yield* readCaptured(prepared.inputRelativeUrl, "assets/0001.png")).toEqual(
        Buffer.from(PNG),
      );

      const store = makeGeneratedDocumentStore();
      const published = yield* publishCapturedDocumentPdf({
        captureId: prepared.expected.captureId,
        render: renderResultFor(prepared.expected),
      }).pipe(Effect.provideService(GeneratedDocumentStore, store.store));
      expect(published.warnings).toEqual(bundle.warnings);
      expect(store.beginProduction).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalDocumentKey: expect.stringMatching(/^conversation-pdf:[0-9a-f]{64}$/u),
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves out an image whose bytes are not the format its type claims", () =>
    Effect.gen(function* () {
      // A HEIC photo named .jpg, and a text file named .png.
      const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheicmif1heic")]);
      const text = new TextEncoder().encode("not an image");
      const prepared = yield* captureConversationBundle({
        ...bundle,
        markdown: "# Photos\n\n![a](scient-asset:att-1) ![b](scient-asset:att-2)\n",
        assets: [
          {
            ...bundle.assets[0]!,
            fileName: "photo.jpg",
            mediaType: "image/jpeg",
            content: { _tag: "bytes", bytes: heic, sha256: sha256Digest(heic) },
          },
          {
            ...bundle.assets[0]!,
            id: "att-2",
            fileName: "notes.png",
            content: { _tag: "bytes", bytes: text, sha256: sha256Digest(text) },
          },
        ],
      });
      const input = decodePageInput(
        new TextDecoder().decode(
          (yield* readCaptured(prepared.inputRelativeUrl, "document.json"))!,
        ),
      );
      expect(input.assets.map((asset) => asset.content)).toEqual([
        { _tag: "unavailable", reason: "unsupported" },
        { _tag: "unavailable", reason: "unsupported" },
      ]);
      expect(prepared.warnings.slice(1).map((warning) => warning.message)).toEqual([
        'Image "photo.jpg" is not a valid JPEG file and was left out.',
        'Image "notes.png" is not a valid PNG file and was left out.',
      ]);
      expect(yield* readCaptured(prepared.inputRelativeUrl, "assets/0001.jpg")).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a bundle that is not a conversation", () =>
    Effect.gen(function* () {
      const error = yield* captureConversationBundle({
        ...bundle,
        metadata: {
          ...bundle.metadata,
          source: { _tag: "workspace-file", cwd: "/p", relativePath: "a.md", revision: digest },
        },
      }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid-source");
    }).pipe(Effect.provide(layer)),
  );
});
