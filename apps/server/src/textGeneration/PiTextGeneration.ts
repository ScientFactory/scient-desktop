/**
 * PiTextGeneration — commit messages, PR content, branch names, and thread
 * titles generated through an ephemeral `pi --mode rpc --no-session` process.
 * No session file is written; the user's Pi configuration (default model,
 * auth, custom providers) still applies.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { TextGenerationError, type PiSettings } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";

// SCIENT-FORK:START — the typed Pi RPC client replaces the line-protocol connection.
import { makePiRpcClient } from "../provider/pi/PiRpcClient.ts";
import {
  makePiRunJson,
  type PiRpcClientFactory,
  type PiTextGenerationOptions,
} from "./ScientPiTextGeneration.ts";
export type { PiTextGenerationOptions } from "./ScientPiTextGeneration.ts";
// SCIENT-FORK:END
import * as TextGenerationOperations from "./TextGenerationOperations.ts";

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  // SCIENT-FORK:START — typed Pi RPC client factory and run options.
  makeRpcClient: PiRpcClientFactory = makePiRpcClient,
  options: PiTextGenerationOptions = {},
  // SCIENT-FORK:END
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // SCIENT-FORK:START — one-shot typed Pi RPC run with native model selection.
  const runPiJson = makePiRunJson({
    settings: piSettings,
    environment,
    makeRpcClient,
    options,
    spawner,
  });
  // SCIENT-FORK:END

  return TextGenerationOperations.fromRunner("PiTextGeneration", runPiJson);
});
