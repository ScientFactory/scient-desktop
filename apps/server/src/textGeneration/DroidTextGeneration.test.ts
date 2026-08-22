// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { DroidSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDroidTextGeneration } from "./DroidTextGeneration.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const DroidTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-droid-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpDroidWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const droidPath = NodePath.join(binDir, "droid");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    droidPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "exec" ] || [ "$2" != "--output-format" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(droidPath, 0o755);
  return droidPath;
}

function withFakeAcpDroid<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-droid-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpDroidWrapper(tempDir, env);
    const config = decodeDroidSettings({ binaryPath });
    const textGeneration = yield* makeDroidTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(DroidTextGenerationTestLayer)("DroidTextGeneration", (it) => {
  it.effect("spawns droid exec --output-format acp and applies the requested model first", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-droid-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpDroid(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Droid provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/droid",
            stagedSummary: "M apps/server/src/provider/Drivers/DroidDriver.ts",
            stagedPatch: "diff --git a/.../DroidDriver.ts b/.../DroidDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "composer-2"),
          });

          expect(generated.subject).toBe("Add Droid provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          // Droid ignores -m/-r in ACP mode; model selection must ride over
          // session/set_config_option with the negotiated option id.
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "composer-2",
            ),
          ).toBe(true);
          expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
          const setConfigIndex = requests.findIndex(
            (request) => request.method === "session/set_config_option",
          );
          const promptIndex = requests.findIndex((request) => request.method === "session/prompt");
          expect(setConfigIndex).toBeGreaterThanOrEqual(0);
          expect(promptIndex).toBeGreaterThan(setConfigIndex);
        }),
    );
  });

  it.effect("extracts the JSON object when Droid wraps it in conversational text", () =>
    withFakeAcpDroid(
      {
        T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "default"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpDroid(
      {
        T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "silent agent",
              modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "default"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
        }),
    ),
  );
});
