// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AntigravitySettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeAntigravityTextGeneration } from "./AntigravityTextGeneration.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../scripts/agy-stream-mock.ts");
const instanceId = ProviderInstanceId.make("antigravity");

const TestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-antigravity-text-generation-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeMockBinary() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-agy-text-"));
  const binaryPath = NodePath.join(directory, "agy");
  NodeFS.writeFileSync(
    binaryPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPath)} "$@"\n`,
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return { directory, binaryPath };
}

function withFakeAgy<A, E, R>(
  structuredOutput: unknown,
  use: (service: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const mock = makeMockBinary();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
    );
    const service = yield* makeAntigravityTextGeneration(
      decodeSettings({ binaryPath: mock.binaryPath }),
      {
        ...process.env,
        AGY_MOCK_STRUCTURED_OUTPUT: encodeUnknownJson(structuredOutput),
      },
    );
    return yield* use(service);
  }).pipe(Effect.scoped);
}

const selection = createModelSelection(instanceId, "gemini-3.7-flash", [
  { id: "reasoning", value: "low" },
]);

it.layer(TestLayer)("AntigravityTextGeneration", (it) => {
  it.effect("uses native structured output for commit messages", () =>
    withFakeAgy(
      {
        subject: "feat(provider): add Antigravity provider",
        body: "Use the Google account subscription through Antigravity.",
      },
      (service) =>
        Effect.gen(function* () {
          const generated = yield* service.generateCommitMessage({
            cwd: process.cwd(),
            modelSelection: selection,
            branch: "feat/antigravity",
            stagedSummary: "2 files changed",
            stagedPatch: "diff --git a/file.txt b/file.txt",
          });
          expect(generated).toEqual({
            subject: "feat(provider): add Antigravity provider",
            body: "Use the Google account subscription through Antigravity.",
          });
        }),
    ),
  );

  it.effect("generates and sanitizes PR content", () =>
    withFakeAgy(
      { title: "Add Antigravity support", body: "## Summary\nNative integration." },
      (service) =>
        Effect.gen(function* () {
          const generated = yield* service.generatePrContent({
            cwd: process.cwd(),
            modelSelection: selection,
            baseBranch: "main",
            headBranch: "feat/antigravity",
            commitSummary: "feat: add provider",
            diffSummary: "5 files changed",
            diffPatch: "diff --git a/provider.ts b/provider.ts",
          });
          expect(generated.title).toBe("Add Antigravity support");
          expect(generated.body).toContain("Native integration.");
        }),
    ),
  );

  it.effect("generates branch names and thread titles", () =>
    Effect.gen(function* () {
      yield* withFakeAgy({ branch: "antigravity-provider" }, (service) =>
        Effect.gen(function* () {
          const generated = yield* service.generateBranchName({
            cwd: process.cwd(),
            modelSelection: selection,
            message: "Implement Antigravity",
          });
          expect(generated.branch).toBe("antigravity-provider");
        }),
      );
      yield* withFakeAgy({ title: "Implement Antigravity Provider" }, (service) =>
        Effect.gen(function* () {
          const generated = yield* service.generateThreadTitle({
            cwd: process.cwd(),
            modelSelection: selection,
            message: "Implement Antigravity",
          });
          expect(generated.title).toBe("Implement Antigravity Provider");
        }),
      );
    }),
  );

  it.effect("rejects schema-invalid structured output", () =>
    withFakeAgy({}, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          service.generateThreadTitle({
            cwd: process.cwd(),
            modelSelection: selection,
            message: "Implement Antigravity",
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toContain("invalid structured output");
      }),
    ),
  );

  it.effect("fails clearly when a requested attachment is unavailable", () =>
    withFakeAgy({ title: "unused" }, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          service.generateThreadTitle({
            cwd: process.cwd(),
            modelSelection: selection,
            message: "Describe this image",
            attachments: [
              {
                type: "image",
                id: "missing-123e4567-e89b-12d3-a456-426614174000",
                name: "missing.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          }),
        );
        expect(error._tag).toBe("TextGenerationError");
        expect(error.detail).toContain("unavailable");
      }),
    ),
  );
});
