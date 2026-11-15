/**
 * The ChatGPT apps Scient Agent's own ChatGPT sign-in has connected (Gmail, Google Drive and the
 * others the person added in ChatGPT). The agent holds the sign-in and lists them with
 * `scient-agent apps --json`; Scient only reports them, and every Scient Agent conversation gets
 * their tools through `SCIENT_AGENT_CHATGPT_APPS`.
 */
import type { ProviderConnectionAccount, ServerProviderMcpServer } from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  canonicalOmpExecutablePath,
  OmpExecutableGate,
} from "../../provider/omp/OmpExecutableGate.ts";
import {
  scientAgentHostCommands,
  scientAgentTarget,
} from "../../provider/scient/ScientAgentTarget.ts";
import { runProviderPluginCommand } from "./ProviderPluginCommand.ts";

/** Every connected app, in every Scient Agent conversation; the agent skips ChatGPT's own features. */
export const SCIENT_AGENT_CHATGPT_APPS_ENV = "SCIENT_AGENT_CHATGPT_APPS";
export const SCIENT_AGENT_CHATGPT_APPS_ALL = "all";

/** Marks a Scient Agent server row as a ChatGPT app rather than one from its MCP settings. */
const CHATGPT_APP_SCOPE = "chatgpt";

/** Where a person adds more apps to their ChatGPT account. */
const CHATGPT_APPS_PAGE = "https://chatgpt.com/apps";

const ChatGptAppsOutput = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
      name: Schema.String,
      tools: Schema.Finite,
    }),
  ),
});
const decodeOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      ChatGptAppsOutput,
      Schema.Struct({ error: Schema.Struct({ kind: Schema.Literal("signed-out") }) }),
    ]),
  ),
);

export const hasChatGptAccount = (
  accounts: ReadonlyArray<ProviderConnectionAccount> | undefined,
): boolean =>
  accounts?.some((account) => account.connected && account.id === "openai-codex") ?? false;

/**
 * ChatGPT's page for one app, where the person connects or reconnects it: built exactly as Codex
 * builds its install links (each character but a-z and 0-9 becomes "-", then the app's id).
 */
function chatGptAppPage(app: { readonly id: string; readonly name: string }): string {
  const slug = app.name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${CHATGPT_APPS_PAGE}/${slug || "app"}/${app.id}`;
}

/** An unreadable answer is distinct from a successful empty listing. */
export function chatGptAppRows(stdout: string): ReadonlyArray<ServerProviderMcpServer> | undefined {
  const decoded = decodeOutput(stdout.trim().split("\n").at(-1) ?? "");
  if (decoded._tag === "None") return undefined;
  if ("error" in decoded.value) return [];
  return decoded.value.apps.flatMap((app): ReadonlyArray<ServerProviderMcpServer> => {
    const name = app.name.trim();
    if (!name) return [];
    return [
      {
        name,
        scope: CHATGPT_APP_SCOPE,
        status: "connected",
        toolCount: Math.max(0, Math.trunc(app.tools)),
        connectUrl: chatGptAppPage({ id: app.id, name }),
        signedIn: true,
      },
    ];
  });
}

const runtimeInfo = Effect.fn("scientAgentRuntimeInfo")(function* (
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  const resolved =
    (yield* resolveCommandPath(executable, { env, bypassCache: true })) ?? executable;
  const gate = yield* OmpExecutableGate;
  yield* gate.acquireProcess(yield* canonicalOmpExecutablePath(resolved), {
    target: scientAgentTarget,
    kind: "one-shot",
  });
  const info = yield* runProviderPluginCommand(resolved, env, cwd, ["--runtime-info"]);
  const runsApps =
    scientAgentTarget.identify(info) !== undefined &&
    scientAgentHostCommands(info).includes("apps");
  return { resolved, runsApps };
});

/** Whether this executable runs ChatGPT apps; an older one ignores the request for them. */
export const scientAgentRunsChatGptApps = Effect.fn("scientAgentRunsChatGptApps")(
  function* (executable: string, env: NodeJS.ProcessEnv, cwd: string) {
    return (yield* runtimeInfo(executable, env, cwd)).runsApps;
  },
  Effect.scoped,
  Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed(false) }),
  Effect.orElseSucceed(() => false),
);

/**
 * An executable without `apps` would read the word as a prompt, so its runtime info must name
 * it first. Failed reads stay failures so callers retain the last published inventory.
 */
export const readScientAgentChatGptApps = Effect.fn("readScientAgentChatGptApps")(
  function* (executable: string, env: NodeJS.ProcessEnv, cwd: string) {
    const { resolved, runsApps } = yield* runtimeInfo(executable, env, cwd);
    if (!runsApps) return [];
    // Signed-out answers are JSON on stdout with exit code 1.
    const output = yield* runProviderPluginCommand(resolved, env, cwd, ["apps", "--json"], {
      acceptNonZeroExit: true,
    });
    const rows = chatGptAppRows(output);
    if (rows === undefined)
      return yield* Effect.fail({ message: "Scient Agent could not read ChatGPT apps." });
    return rows;
  },
  Effect.scoped,
  Effect.timeout("90 seconds"),
  Effect.mapError(() => ({ message: "Scient Agent could not read ChatGPT apps." })),
);
