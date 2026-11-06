import type { SourceControlCredentials } from "@t3tools/source-control-core/server/driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SourceControlDrivers } from "../../../sourceControl/builtInDrivers.ts";

/** GitHub's hosted MCP server, the one place Source Control's GitHub credential may be sent. */
const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

/** Source Control's GitHub credential, and the MCP endpoint it may be sent to. */
export class GitHubSourceControlCredential extends Context.Service<
  GitHubSourceControlCredential,
  SourceControlCredentials & { readonly mcpUrl: string }
>()("t3/scient/extensions/connectors/GitHubSourceControlCredential") {}

/**
 * Whether `url` is `mcpUrl` or below it on the same origin, the only place the credential may go.
 * Toolset paths such as `/mcp/readonly` stay inside; another host, port or path never does.
 */
export const isCredentialDestination = (url: string, mcpUrl: string): boolean => {
  const target = URL.parse(url);
  const allowed = new URL(mcpUrl);
  if (target === null || target.username !== "" || target.password !== "") return false;
  const base = allowed.pathname.replace(/\/+$/, "");
  return (
    target.origin === allowed.origin &&
    (target.pathname === base || target.pathname.startsWith(`${base}/`))
  );
};

export const layer = Layer.effect(
  GitHubSourceControlCredential,
  Effect.gen(function* () {
    const drivers = yield* SourceControlDrivers;
    const credential = drivers.find((entry) => entry.driver.kind === "github")?.instance.credential;
    return GitHubSourceControlCredential.of({
      mcpUrl: GITHUB_MCP_URL,
      get: credential?.get ?? (() => Effect.succeedNone),
      invalidate: credential?.invalidate ?? (() => Effect.void),
    });
  }),
);
