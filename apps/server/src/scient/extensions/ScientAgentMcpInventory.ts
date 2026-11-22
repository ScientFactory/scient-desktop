import type { ServerProviderMcpServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { readPluginJson } from "./LocalPluginFiles.ts";

const Config = Schema.Struct({
  mcpServers: Schema.Record(
    Schema.String,
    Schema.Struct({
      disabled: Schema.optional(Schema.Boolean),
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeConfig = Schema.decodeUnknownEffect(Config);
export const readScientAgentMcpServers = Effect.fn("readScientAgentMcpServers")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(root, "agent", "mcp.json");
    if (!(yield* fs.exists(file))) return [];
    const config = yield* readPluginJson(file).pipe(Effect.flatMap(decodeConfig));
    return Object.entries(config.mcpServers)
      .slice(0, 1000)
      .filter(([name]) => name.trim().length > 0)
      .map(([name, server]): ServerProviderMcpServer => ({
        name,
        scope: "user",
        status: server.disabled || server.enabled === false ? "disabled" : "unknown",
      }));
  },
  Effect.mapError(() => ({ message: "Could not read Scient Agent's MCP configuration." })),
);

const McpListOutput = Schema.Union([
  Schema.Struct({
    servers: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literals(["connected", "needs-auth", "failed", "pending"]),
        scope: Schema.optional(Schema.String),
        pluginId: Schema.optional(Schema.String),
        toolCount: Schema.optional(Schema.Finite),
        error: Schema.optional(Schema.String),
        canStartSignIn: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]);
const decodeMcpList = Schema.decodeUnknownOption(Schema.fromJsonString(McpListOutput));

const nonEmpty = (text: string | undefined) => {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
};

/** The servers `scient-agent mcp list` connected, or a failure for an error or unreadable answer. */
export function scientAgentMcpRows(
  stdout: string,
): Effect.Effect<ReadonlyArray<ServerProviderMcpServer>, { readonly message: string }> {
  const decoded = decodeMcpList(stdout.trim().split("\n").at(-1) ?? "");
  if (decoded._tag === "None")
    return Effect.fail({ message: "Scient Agent's MCP server list could not be read." });
  if ("error" in decoded.value)
    return Effect.fail({
      message: nonEmpty(decoded.value.error.message) ?? "Scient Agent could not list MCP servers.",
    });
  return Effect.succeed(
    decoded.value.servers
      .slice(0, 1000)
      .flatMap((server): ReadonlyArray<ServerProviderMcpServer> => {
        const name = nonEmpty(server.name);
        if (!name) return [];
        const pluginId = nonEmpty(server.pluginId);
        const scope = nonEmpty(server.scope);
        const error = nonEmpty(server.error);
        return [
          {
            name,
            status: server.status,
            ...(pluginId ? { pluginId } : {}),
            ...(scope ? { scope } : {}),
            ...(server.toolCount === undefined
              ? {}
              : { toolCount: Math.max(0, Math.trunc(server.toolCount)) }),
            ...(error ? { error } : {}),
            ...(server.canStartSignIn === true ? { canStartSignIn: true } : {}),
          },
        ];
      }),
  );
}

const LoginLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("authorization_url"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("completed") }),
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]);
const decodeLoginLine = Schema.decodeUnknownOption(Schema.fromJsonString(LoginLine));
type LoginEvent = typeof LoginLine.Type | { readonly type: "exited" };

/** The agent's own flow gives up after five minutes; this only catches one that never reports. */
const SIGN_IN_WAIT = "330 seconds";
const AUTHORIZATION_URL_WAIT = "90 seconds";

/**
 * Follows `scient-agent mcp login <name>`: an authorization page, then one terminal line. The
 * process holds the browser callback listener, so it lives in the caller's scope until then.
 */
export const scientAgentMcpSignIn = Effect.fn("scientAgentMcpSignIn")(function* (
  lines: Stream.Stream<string, { readonly message: string }>,
  serverName: string,
) {
  const events = yield* Queue.unbounded<LoginEvent>();
  yield* lines.pipe(
    Stream.runForEach((line) => {
      const event = decodeLoginLine(line.trim());
      return event._tag === "Some" ? Queue.offer(events, event.value) : Effect.void;
    }),
    Effect.exit,
    Effect.andThen(Queue.offer(events, { type: "exited" })),
    Effect.forkScoped,
  );
  const failure = (event: LoginEvent): { readonly message: string } => ({
    message:
      ("error" in event
        ? nonEmpty(event.error.message)
        : event.type === "failed"
          ? nonEmpty(event.message)
          : undefined) ?? `Scient Agent did not finish signing in to '${serverName}'.`,
  });
  const first = yield* Queue.take(events).pipe(
    Effect.timeoutOrElse({
      duration: AUTHORIZATION_URL_WAIT,
      orElse: () =>
        Effect.fail({ message: `Scient Agent did not open a sign-in page for '${serverName}'.` }),
    }),
  );
  if (!("type" in first) || first.type !== "authorization_url")
    return yield* Effect.fail(failure(first));
  const waitForCompletion: Effect.Effect<void, { readonly message: string }> = Effect.gen(
    function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if ("type" in event && event.type === "completed") return;
        if ("type" in event && event.type === "authorization_url") continue;
        return yield* Effect.fail(failure(event));
      }
    },
  ).pipe(
    Effect.timeoutOrElse({
      duration: SIGN_IN_WAIT,
      orElse: () =>
        Effect.fail({
          message: `Scient Agent did not report the sign-in to '${serverName}' finishing in time.`,
        }),
    }),
  );
  return { authorizationUrl: first.url, waitForCompletion };
});
