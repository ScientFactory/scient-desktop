import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ClaudeSettings, ServerProviderMcpServer } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { makeClaudeEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import { resolveClaudeSdkExecutablePath } from "../../provider/Drivers/ClaudeExecutable.ts";
import {
  claudeNativeMcpServers,
  type ClaudeMcpServerReport,
} from "../../provider/ProviderNativeInventory.ts";
import type { ClaudeCapabilitiesProbe } from "../../provider/ClaudeProvider.ts";

const encodeServers = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ServerProviderMcpServer)),
);

export const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

export function accountConnectorOptions(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  abort: AbortController,
): Options {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: executable,
    abortController: abort,
    settingSources: [],
    mcpServers: {},
    settings: { disableAllHooks: true },
    allowedTools: [],
    env: {
      ...env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    cwd,
    stderr: () => {},
  };
}

export const pollClaudeAccountServers = Effect.fn("pollClaudeAccountServers")(function* <E>(
  sample: () => Effect.Effect<ReadonlyArray<ClaudeMcpServerReport>, E>,
) {
  let previous: string | undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    const servers = (yield* sample()).filter((server) => server.scope === "claudeai");
    const result = claudeNativeMcpServers(servers, new Set()).map((server) => ({
      ...server,
      connectUrl: CLAUDE_CONNECTORS_URL,
    }));
    const key = encodeServers([...result].sort((a, b) => a.name.localeCompare(b.name)));
    if (result.length > 0 && key === previous) return result;
    previous = key;
    yield* Effect.sleep("1 second");
  }
  return yield* Effect.fail({ message: "Claude did not finish listing its account connectors." });
});

export const probeClaudeAccountServers = Effect.fn("probeClaudeAccountServers")(
  function* (settings: ClaudeSettings, environment: NodeJS.ProcessEnv, cwd: string) {
    const env = yield* makeClaudeEnvironment(settings, environment);
    const executable = yield* resolveClaudeSdkExecutablePath(settings.binaryPath, env);
    const abort = new AbortController();
    const q = yield* Effect.acquireRelease(
      Effect.sync(() =>
        query({
          // oxlint-disable-next-line require-yield -- promptless initialization must never call the model
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            await new Promise<void>((resolve) =>
              abort.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          })(),
          options: accountConnectorOptions(executable, env, cwd, abort),
        }),
      ),
      (active) =>
        Effect.sync(() => {
          abort.abort();
          active.close();
        }),
    );
    return yield* pollClaudeAccountServers(() => Effect.tryPromise(() => q.mcpServerStatus()));
  },
  Effect.timeout("15 seconds"),
  Effect.scoped,
);

export const makeClaudeAccountInventoryRefresh = Effect.fn("makeClaudeAccountInventoryRefresh")(
  function* <E>(
    account: Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
    probe: Effect.Effect<ReadonlyArray<ServerProviderMcpServer>, E>,
    publish: (servers: ReadonlyArray<ServerProviderMcpServer>) => Effect.Effect<void>,
  ) {
    const lock = yield* Semaphore.make(1);
    const lastRead = yield* Ref.make<number | undefined>(undefined);
    return ({ force = false }: { readonly force?: boolean | undefined } = {}) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* account;
          if (current?.apiProvider !== "firstParty" || !current.subscriptionType) {
            yield* publish([]);
            return;
          }
          const now = yield* Clock.currentTimeMillis;
          const last = yield* Ref.get(lastRead);
          if (!force && last !== undefined && now - last < 600_000) return;
          yield* Ref.set(lastRead, now);
          const servers = yield* probe;
          yield* publish(servers);
        }).pipe(
          Effect.mapError(() => ({ message: "Could not read Claude's account connectors." })),
        ),
      );
  },
);
