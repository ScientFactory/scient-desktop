// @effect-diagnostics nodeBuiltinImport:off -- Resolves a bundle path against the chat's folder.
/**
 * Agents see, add and run the user's connectors, hosted and local, through the same runtime calls
 * the Extensions page makes: Discover's entries, the add, turning on and off, restarting, the test
 * and the sign-in. Nothing here installs or signs in on its own.
 */
import * as NodePath from "node:path";

import {
  type ConnectorAddInput,
  type ConnectorSummary,
  type DiscoverEntry,
  ExtensionsError,
  type VaultSecretRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { agentStatusOf, oneLine, type AgentConnectorStatus } from "./connectors/agentStatus.ts";
import { observeFeature } from "./connectors/observedFeature.ts";
import {
  type ConnectorLocation,
  ConnectorRuntime,
  ExtensionsDiscover,
} from "./ExtensionsServices.ts";

const MAX_FOUND = 10;
const CURATED_ONLY_PREFIX = "scient.curated/";
/** GitHub's own server connects with Source Control's account, set up on the page. */
const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

const invalid = (message: string) => new ExtensionsError({ reason: "invalid-input", message });
const notFound = (message: string) => new ExtensionsError({ reason: "not-found", message });

const services = Effect.gen(function* () {
  const runtime = yield* Effect.serviceOption(ConnectorRuntime);
  if (Option.isNone(runtime))
    return yield* new ExtensionsError({
      reason: "unsupported",
      message: "Connectors are unavailable here.",
    });
  return {
    runtime: runtime.value,
    discover: yield* Effect.serviceOption(ExtensionsDiscover),
    observed: observeFeature(Option.getOrUndefined(yield* Effect.serviceOption(AnalyticsService))),
  };
});

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const findSummary = (connectors: ReadonlyArray<ConnectorSummary>, name: string) =>
  connectors.find(
    (item) =>
      item.serverName === name.trim() ||
      item.connectorId === name.trim() ||
      same(item.displayName, name),
  );

const requireSummary = Effect.fn("ConnectorAgentControl.find")(function* (name: string) {
  const { runtime } = yield* services;
  const found = findSummary((yield* runtime.list()).connectors, name);
  if (found === undefined)
    return yield* notFound(`No connector is named ${name}. scient_connector_list shows them.`);
  return found;
});

const rowOf = (summary: ConnectorSummary) => {
  const missing = [
    ...(summary.local?.missing ?? []),
    ...(summary.status === "needs-credential" ? ["its key"] : []),
  ];
  return {
    connector: summary.serverName,
    name: summary.displayName,
    kind: summary.local === undefined ? ("hosted" as const) : ("local" as const),
    on: summary.enabled,
    status: agentStatusOf(summary),
    ...(summary.lastError === undefined ? {} : { lastError: oneLine(summary.lastError) }),
    ...(missing.length === 0 ? {} : { missing }),
  };
};

/** What the private card asks for a hosted entry: its API key, or the user's own sign-in app. */
type Needs = "key" | "sign-in-app";

/** What `connectors.add` gets for an entry an agent adds, or why the user must add it. */
const agentAddTarget = (
  entry: DiscoverEntry,
):
  | { readonly target: ConnectorAddInput["target"]; readonly needs?: Needs }
  | { readonly reason: string } => {
  if (!entry.installable) return { reason: entry.unsupportedReason ?? "Scient can't run it." };
  const remote = entry.remotes.find(
    (item) => item.type === "streamable-http" && !item.requiresInput,
  );
  const onPage = "the user adds it from its page in Settings → Extensions → Discover";
  if (remote !== undefined) {
    if (remote.url === GITHUB_MCP_URL)
      return { reason: `It connects with the user's GitHub account: ${onPage}` };
    return {
      target: entry.name.startsWith(CURATED_ONLY_PREFIX)
        ? { type: "url", url: remote.url }
        : { type: "registry", name: entry.name, version: entry.version, url: remote.url },
      ...(entry.apiKey !== undefined
        ? { needs: "key" as const }
        : entry.oauthClientRequired === true
          ? { needs: "sign-in-app" as const }
          : {}),
    };
  }
  if (entry.localPackage !== undefined)
    return {
      target: {
        type: "local-package",
        name: entry.name,
        version: entry.version,
        package: entry.localPackage,
        environment: [],
      },
    };
  if (entry.localBundle !== undefined)
    return {
      target: {
        type: "registry-bundle",
        name: entry.name,
        version: entry.version,
        bundle: entry.localBundle,
      },
    };
  if (entry.address !== undefined)
    return { reason: `It needs the address of its server: ${onPage}` };
  return { reason: entry.unsupportedReason ?? "Scient can't run it." };
};

const foundRow = (entry: DiscoverEntry, connectors: ReadonlyArray<ConnectorSummary>) => {
  const choice = agentAddTarget(entry);
  const added = connectors.find((item) => item.connectorId === entry.installedConnectorId);
  const description = entry.tagline ?? entry.description;
  return {
    name: entry.name,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(description === undefined ? {} : { description: oneLine(description, 200) }),
    addable: "target" in choice && added === undefined,
    ...("reason" in choice ? { reason: choice.reason } : {}),
    ...(added === undefined ? {} : { added: added.serverName }),
  };
};

/** The user's connectors and, for a query, ones Scient can add (its own picks, then the Registry). */
export const listConnectors = Effect.fn("ConnectorAgentControl.list")(function* (input: {
  readonly query?: string | undefined;
}) {
  const { runtime, discover, observed } = yield* services;
  return yield* observed("connectors.agent.list", { searched: input.query !== undefined })(
    Effect.gen(function* () {
      const { connectors } = yield* runtime.list();
      const rows = connectors.map(rowOf);
      if (input.query === undefined) return { connectors: rows };
      if (Option.isNone(discover))
        return { connectors: rows, found: [], message: "Discover is unavailable here." };
      const query = input.query;
      const [curated, registry] = yield* Effect.all(
        [
          discover.value.search({ scope: "curated", query }),
          discover.value.search({ scope: "registry", query, limit: MAX_FOUND }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      const byName = new Map<string, DiscoverEntry>();
      for (const entry of [
        ...curated.entries,
        ...(registry._tag === "Success" ? registry.success.entries : []),
      ])
        if (!byName.has(entry.name)) byName.set(entry.name, entry);
      const entries = [...byName.values()];
      return {
        connectors: rows,
        found: entries.slice(0, MAX_FOUND).map((entry) => foundRow(entry, connectors)),
        ...(registry._tag === "Failure"
          ? {
              message: "The MCP Registry could not be searched just now; these are Scient's picks.",
            }
          : {}),
      };
    }),
    (listed) => ({
      connectors: listed.connectors.length,
      found: "found" in listed ? listed.found.length : 0,
    }),
  );
});

const nextStep = (summary: ConnectorSummary, status: AgentConnectorStatus) => {
  const name = summary.displayName;
  const server = summary.serverName;
  switch (status) {
    case "needs-setup":
      return `${name} still needs ${rowOf(summary).missing?.join(", ") ?? "setup"}: call scient_connector_setup {"connector":"${server}"}.`;
    case "needs-sign-in":
      return `${name} needs the user to sign in: call scient_connector_control {"connector":"${server}","action":"sign-in"}.`;
    case "error":
      return `${name} has a problem: ${oneLine(summary.local?.problem ?? summary.lastError ?? "it did not start")} scient_connector_check {"connector":"${server}"} shows more${summary.local === undefined ? "" : "; scient_connector_copy fixes it"}.`;
    case "off":
      return `${name} is off: scient_connector_control {"connector":"${server}","action":"on"} turns it on.`;
    case "ready":
      return `Its tools reach new chats from the user's next message, as mcp__${server}__<tool>.`;
  }
};

/** How a connector stands after an agent added or saved it, and what is left to do. */
export const changeReport = (
  verb: "Added" | "Saved",
  summary: ConnectorSummary,
  tools: ReadonlyArray<string>,
) => {
  const status = agentStatusOf(summary);
  const reach = !summary.enabled
    ? ""
    : summary.availability.type === "all-projects"
      ? ", on for every project"
      : ", on for the projects the user chose";
  const undo =
    verb === "Saved" ? " The user can undo this on its page in Settings → Extensions." : "";
  return {
    connector: summary.serverName,
    status,
    tools,
    missing: rowOf(summary).missing ?? [],
    message: `${verb} ${summary.displayName}${reach}. ${nextStep(summary, status)}${undo}`,
  };
};

const testedTools = Effect.fn("ConnectorAgentControl.testedTools")(function* (
  summary: ConnectorSummary,
  location: ConnectorLocation | undefined,
) {
  const { runtime } = yield* services;
  const tested = yield* runtime.test({ connectorId: summary.connectorId, location });
  return tested.outcome === "ok"
    ? { tools: tested.tools.map((tool) => tool.name) }
    : { tools: [], problem: tested.message ?? `Its test ended with ${tested.outcome}.` };
});

/**
 * The user's answers in Scient's private card, which never pass through the chat: an API key
 * (kept in Accounts, returned as its reference), or their own sign-in app's ID and secret.
 */
export interface AddAsks {
  readonly key: (request: {
    readonly name: string;
    readonly reason: string;
    readonly site: string;
    readonly header?: string;
  }) => Effect.Effect<{ readonly secretRef: VaultSecretRef } | { readonly problem: string }>;
  readonly signInApp: (request: {
    readonly name: string;
    readonly redirectUri: string | undefined;
  }) => Effect.Effect<
    { readonly clientId: string; readonly clientSecret?: string } | { readonly problem: string }
  >;
}

const isPath = (from: string) => /\.(mcpb|zip)$/iu.test(from) && !/^https?:\/\//iu.test(from);

/**
 * Adds a Discover or Registry entry by name, a hosted connector by https address, or a `.mcpb`
 * file, as the Extensions page would; it is on for every project.
 */
export const addConnector = Effect.fn("ConnectorAgentControl.add")(function* (input: {
  readonly from: string;
  /** Where a relative bundle path is read from: the chat's folder. */
  readonly workingFolder?: string | undefined;
  /** The chat's project: the add's own test uses only what that project may use. */
  readonly location?: ConnectorLocation | undefined;
  /** Asks the user for a hosted connector's key or sign-in app; absent where no one can answer. */
  readonly asks?: AddAsks | undefined;
}) {
  const { runtime, discover, observed } = yield* services;
  const from = input.from.trim();
  const variant = /^https?:\/\//iu.test(from) ? "url" : isPath(from) ? "bundle" : "discover";
  return yield* observed("connectors.agent.add", { variant })(
    Effect.gen(function* () {
      let request: ConnectorAddInput;
      if (variant === "url") request = { target: { type: "url", url: from } };
      else if (variant === "bundle") {
        if (!NodePath.isAbsolute(from) && input.workingFolder === undefined)
          return yield* invalid("Give the bundle's full path.");
        const path = NodePath.isAbsolute(from)
          ? from
          : NodePath.resolve(input.workingFolder!, from);
        request = { target: { type: "local-bundle", path, settings: {}, keys: {} } };
      } else {
        if (Option.isNone(discover)) return yield* invalid("Discover is unavailable here.");
        const entry = yield* discover.value
          .entry({ name: from })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "not-found"
                ? notFound(
                    `Discover has nothing named ${from}. scient_connector_list {"query":"…"} finds its name.`,
                  )
                : error,
            ),
          );
        const existing =
          entry.installedConnectorId === undefined
            ? undefined
            : findSummary((yield* runtime.list()).connectors, entry.installedConnectorId);
        if (existing !== undefined) {
          const status = agentStatusOf(existing);
          return {
            connector: existing.serverName,
            status,
            tools: [],
            missing: rowOf(existing).missing ?? [],
            message: `${existing.displayName} is already added. ${nextStep(existing, status)}`,
          };
        }
        const choice = agentAddTarget(entry);
        if ("reason" in choice)
          return yield* invalid(
            `Scient can't add ${entry.title ?? entry.name} for you: ${choice.reason}. To build one instead, use the connector-authoring skill.`,
          );
        const description = entry.description?.trim().slice(0, 1_000);
        const displayName = entry.title ?? entry.name.split("/").pop() ?? entry.name;
        request = {
          target: choice.target,
          displayName,
          ...(description ? { description } : {}),
          ...(choice.needs === undefined
            ? {}
            : yield* askedSetup(entry, choice.target, choice.needs, displayName, input.asks)),
        };
      }
      const added = yield* runtime.add({ ...request, changedBy: "agent" });
      const summary = added.connector;
      if (agentStatusOf(summary) !== "ready") return changeReport("Added", summary, []);
      const tested = yield* testedTools(summary, input.location);
      if (tested.problem === undefined) return changeReport("Added", summary, tested.tools);
      return {
        connector: summary.serverName,
        status: "error" as const,
        tools: tested.tools,
        missing: [],
        message: `Added ${summary.displayName}, on for every project, but its check failed: ${oneLine(tested.problem)} scient_connector_check {"connector":"${summary.serverName}"} shows more.`,
      };
    }),
    (result) => ({ status: result.status, tools: result.tools.length }),
  );
});

/** A hosted entry's key or sign-in app, asked in the private card, as the add takes it. */
const askedSetup = Effect.fn("ConnectorAgentControl.askedSetup")(function* (
  entry: DiscoverEntry,
  target: ConnectorAddInput["target"],
  needs: Needs,
  name: string,
  asks: AddAsks | undefined,
) {
  const what = needs === "key" ? "an API key" : "the user's own sign-in app (its client ID)";
  if (asks === undefined || !("url" in target))
    return yield* invalid(
      `${name} needs ${what}, which Scient asks for in a private card, and no one can answer one here. The user adds it from its page in Settings → Extensions → Discover.`,
    );
  if (needs === "key") {
    const key = entry.apiKey!;
    const asked = yield* asks.key({
      name,
      reason: `${name} needs it to connect. Where to get it: ${key.helpUrl}`,
      site: new URL(target.url).origin,
      ...(key.strategy === "header" && key.headerName !== undefined
        ? { header: key.headerName }
        : {}),
    });
    if ("problem" in asked) return yield* invalid(`${name} was not added: ${asked.problem}`);
    return {
      credential: {
        type: "bound" as const,
        secretRef: asked.secretRef,
        strategy: key.strategy,
        ...(key.headerName === undefined ? {} : { headerName: key.headerName }),
      },
    };
  }
  const origin = yield* callbackOrigin;
  const asked = yield* asks.signInApp({
    name,
    redirectUri: origin === undefined ? undefined : `${origin}/oauth/connectors/callback`,
  });
  if ("problem" in asked) return yield* invalid(`${name} was not added: ${asked.problem}`);
  return { oauthClient: asked };
});

/** Scient's own address, for a sign-in that comes back to it on this computer. */
const callbackOrigin = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(config) || config.value.port === 0) return undefined;
  const host = config.value.host;
  const loopback =
    host === undefined || ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(host);
  return loopback ? `http://127.0.0.1:${config.value.port}` : undefined;
});

export type ControlAction = "on" | "off" | "restart" | "sign-in";

/**
 * Turns a connector on or off, restarts a local one, or opens a sign-in for the user to finish:
 * `open` shows a page to the user and says whether it could.
 */
export const controlConnector = Effect.fn("ConnectorAgentControl.control")(function* (
  input: { readonly connector: string; readonly action: ControlAction },
  open: (url: string) => Effect.Effect<boolean>,
) {
  const { runtime, observed } = yield* services;
  return yield* observed("connectors.agent.control", { variant: input.action })(
    Effect.gen(function* () {
      const summary = yield* requireSummary(input.connector);
      const name = summary.displayName;
      const server = summary.serverName;
      const now = Effect.map(
        runtime.list(),
        ({ connectors }) => findSummary(connectors, summary.connectorId) ?? summary,
      );
      const result = (current: ConnectorSummary, message: string, signInUrl?: string) => ({
        connector: current.serverName,
        status: agentStatusOf(current),
        message,
        ...(signInUrl === undefined ? {} : { signInUrl }),
      });
      switch (input.action) {
        case "on":
        case "off": {
          yield* runtime.update({
            connectorId: summary.connectorId,
            enabled: input.action === "on",
          });
          const current = yield* now;
          return result(
            current,
            input.action === "off"
              ? `${name} is off. Agents stop getting it from the user's next message.`
              : `${name} is on. ${nextStep(current, agentStatusOf(current))}`,
          );
        }
        case "restart": {
          if (summary.local === undefined)
            return yield* invalid(
              `${name} runs online, so there is nothing to restart. scient_connector_check {"connector":"${server}"} tests it.`,
            );
          yield* runtime.update({ connectorId: summary.connectorId, restart: true });
          return result(
            yield* now,
            `${name} restarted: its next call starts a fresh copy with its current files and setup.`,
          );
        }
        case "sign-in": {
          const local = summary.local;
          if (local !== undefined) {
            if (local.signIn === undefined)
              return yield* invalid(
                `${name} doesn't sign in to a site. Its keys and settings: scient_connector_setup {"connector":"${server}"}.`,
              );
            return result(
              summary,
              local.signIn.accountId === undefined
                ? `${name} needs an Accounts sign-in for ${local.signIn.site}: scient_connector_setup {"connector":"${server}","signIn":"…"} links one.`
                : `${name} uses the user's “${local.signIn.account ?? local.signIn.accountId}” sign-in for ${local.signIn.site}. Call scient_account_sign_in {"accountId":"${local.signIn.accountId}"}; the user finishes in the tab it opens. Then scient_connector_control {"connector":"${server}","action":"restart"}.`,
            );
          }
          if (summary.auth.type === "credential")
            return yield* invalid(
              `${name} uses a key, not a sign-in. The user changes it on its page in Settings → Extensions.`,
            );
          if (summary.auth.type === "source-control")
            return yield* invalid(
              `${name} uses the user's GitHub account from Source Control. They sign in again in Settings → Source Control.`,
            );
          const origin = yield* callbackOrigin;
          if (origin === undefined)
            return yield* invalid(
              `Ask the user to press Sign in on ${name}'s page in Settings → Extensions.`,
            );
          const started = yield* runtime
            .startSignIn({ connectorId: summary.connectorId, callbackOrigin: origin })
            .pipe(Effect.result);
          if (started._tag === "Failure") {
            // A server that turned out not to need a sign-in is connected by the attempt.
            const current = yield* now;
            if (agentStatusOf(current) === "ready") return result(current, started.failure.message);
            return yield* started.failure;
          }
          const url = started.success.authorizationUrl;
          return (yield* open(url))
            ? result(
                summary,
                `Opened ${name}'s sign-in in this chat's browser. The user finishes it there; Scient keeps the sign-in. Then scient_connector_check {"connector":"${server}"} lists its tools.`,
              )
            : result(
                summary,
                `Give the user this link to sign in to ${name}: ${url} Scient keeps the sign-in. Then scient_connector_check {"connector":"${server}"} lists its tools.`,
                url,
              );
        }
      }
    }),
    (controlled) => ({ status: controlled.status }),
  );
});

/** The installed connector's own test: it starts (or is reached), and lists its tools. */
export const testConnector = Effect.fn("ConnectorAgentControl.test")(function* (
  name: string,
  location: ConnectorLocation | undefined,
) {
  const { runtime, observed } = yield* services;
  return yield* observed("connectors.agent.check", { variant: "installed" })(
    Effect.gen(function* () {
      const summary = yield* requireSummary(name);
      const tested = yield* runtime.test({ connectorId: summary.connectorId, location });
      const missing = rowOf(summary).missing ?? [];
      const why =
        tested.outcome === "needs-auth"
          ? `It needs the user to sign in: scient_connector_control {"connector":"${summary.serverName}","action":"sign-in"}.`
          : tested.outcome === "needs-setup"
            ? `It needs setup: scient_connector_setup {"connector":"${summary.serverName}"}.`
            : undefined;
      return {
        ok: tested.outcome === "ok",
        tools: tested.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
        })),
        calls: [],
        missing,
        ...(tested.outcome === "ok"
          ? {}
          : {
              error:
                [tested.message, why].filter((part) => part !== undefined).join(" ") ||
                `Its test ended with ${tested.outcome}.`,
            }),
      };
    }),
    (checked) => ({ checked: checked.ok, tools: checked.tools.length }),
  );
});
