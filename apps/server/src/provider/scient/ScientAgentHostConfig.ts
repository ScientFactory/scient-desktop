import type { ProviderConnectionAccount } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The agent reads these `--config` overlays above its own settings files, and watches them. */
export const SCIENT_AGENT_CONFIG_FILES_ENV = "SCIENT_AGENT_CONFIG_FILES";
const HOST_CONFIG_FILE = "scient-host.yml";

export interface ScientAgentHostConfigInput {
  readonly computerControl: boolean;
  readonly imageGeneration: boolean;
}

/** The agent's sign-ins whose models make pictures: ChatGPT's hosted images and Antigravity's Gemini. */
const IMAGE_ACCOUNTS: ReadonlySet<string> = new Set(["openai-codex", "google-antigravity"]);

export const hasImageGenerationAccount = (
  accounts: ReadonlyArray<ProviderConnectionAccount> | undefined,
): boolean =>
  accounts?.some((account) => account.connected && IMAGE_ACCOUNTS.has(account.id)) ?? false;

/**
 * Scient runs every Scient Agent conversation with full access, so the desktop's own
 * foreground-control request is answered the same way instead of asking again.
 */
export const scientAgentHostConfigText = (input: ScientAgentHostConfigInput): string =>
  [
    "# Scient writes this file for the agent it runs and replaces it when settings change.",
    "computer:",
    `  enabled: ${input.computerControl}`,
    ...(input.computerControl ? ["tools:", "  approval:", "    computer.control: allow"] : []),
    "generate_image:",
    `  enabled: ${input.imageGeneration}`,
    // An active goal keeps working between turns, as in the agent's terminal.
    "goal:",
    "  continuationModes: [interactive, rpc]",
    "",
  ].join("\n");

/** Writes the overlay atomically, so the agent's watcher never reads half a file. */
export const writeScientAgentHostConfig = Effect.fn("ScientAgentHostConfig.write")(function* (
  root: string,
  input: ScientAgentHostConfigInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, HOST_CONFIG_FILE);
  const text = scientAgentHostConfigText(input);
  const current = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
  if (current === text) return file;
  const staging = `${file}.tmp`;
  yield* fs.writeFileString(staging, text, { mode: 0o600 });
  yield* fs
    .rename(staging, file)
    .pipe(Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)));
  return file;
});
