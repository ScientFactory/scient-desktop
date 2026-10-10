/**
 * Pi one-shot text generation for commits, PRs, branch names and titles.
 * Uses the same selected model/reasoning policy as interactive sessions, with
 * extensions, skills, tools and persisted session state disabled.
 */
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PiSettings } from "../settings.ts";
import { makePiRpcClient } from "./rpcClient.ts";
import {
  makePiRunJson,
  type PiRpcClientFactory,
  type PiTextGenerationOptions,
} from "./textGenerationRun.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

export type { PiTextGenerationOptions } from "./textGenerationRun.ts";

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeRpcClient: PiRpcClientFactory = makePiRpcClient,
  options: PiTextGenerationOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runPiJson = makePiRunJson({
    settings: piSettings,
    environment,
    makeRpcClient,
    options,
    spawner,
  });
  return TextGenerationOperations.fromRunner("PiTextGeneration", runPiJson);
});
