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
  type ProjectId,
  type ProviderInstanceId,
  type DiscoverEntry,
  ExtensionsError,
  type VaultSecretRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import {
  agentStatusOf,
  oneLine,
  setupAdvice,
  type AgentConnectorStatus,
} from "./connectors/agentStatus.ts";
import { connectorHostOf } from "./connectors/ConnectorDiscovery.ts";
import { observeFeature } from "./connectors/observedFeature.ts";
import {
  type ConnectorLocation,
  ConnectorRuntime,
  ExtensionsDiscover,
  type ExtensionsDiscoverShape,
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

/** Whether the person gave this connector to the calling agent; every agent when none were chosen. */
const forThisAgent = (
  summary: Pick<ConnectorSummary, "agents">,
  caller: ProviderInstanceId | undefined,
) => summary.agents === undefined || caller === undefined || summary.agents.includes(caller);

/** Said with the name the agent asked for, so it learns nothing it did not already say. */
const notForThisAgent = (asked: string) =>
  `${asked} is not available to this agent. The person can choose this agent on its page in Settings → Extensions.`;

const rowOf = (summary: ConnectorSummary) => {
  const host = summary.local === undefined ? connectorHostOf(summary.url) : undefined;
  const missing = [
    ...(summary.local?.missing ?? []),
    ...(summary.status === "needs-credential" ? ["its key"] : []),
  ];
  return {
    connector: summary.serverName,
    name: summary.displayName,
    kind: summary.local === undefined ? ("hosted" as const) : ("local" as const),
    ...(host === undefined ? {} : { host }),
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

/**
 * `connectors` are the ones this agent may use. One added for other agents only is named neither
 * as added nor as addable: adding it again would make a second copy.
 */
const foundRow = (
  entry: DiscoverEntry,
  connectors: ReadonlyArray<ConnectorSummary>,
  elsewhere: ReadonlySet<string>,
) => {
  const choice = agentAddTarget(entry);
  const added = connectors.find((item) => item.connectorId === entry.installedConnectorId);
  const forOthers =
    entry.installedConnectorId !== undefined && elsewhere.has(entry.installedConnectorId);
  const description = entry.tagline ?? entry.description;
  const host =
    "target" in choice && "url" in choice.target ? connectorHostOf(choice.target.url) : undefined;
  return {
    name: entry.name,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(description === undefined ? {} : { description: oneLine(description, 200) }),
    ...(host === undefined ? {} : { host }),
    // Only Scient's picks carry hosting; a Registry server is a third party's listing.
    hosting: entry.hosting ?? "Not checked by Scient",
    addable: "target" in choice && added === undefined && !forOthers,
    ...(forOthers
      ? {
          reason:
            "Already added for other agents. The person can choose this agent on its page in Settings → Extensions.",
        }
      : "reason" in choice
        ? { reason: choice.reason }
        : {}),
    ...(added === undefined ? {} : { added: added.serverName }),
  };
};

/** Scient's picks, then the Registry's, for a query; each name once. */
const searchEntries = Effect.fn("ConnectorAgentControl.search")(function* (
  discover: ExtensionsDiscoverShape,
  query: string,
) {
  const [curated, registry] = yield* Effect.all(
    [
      discover.search({ scope: "curated", query }),
      discover.search({ scope: "registry", query, limit: MAX_FOUND }).pipe(Effect.result),
    ],
    { concurrency: 2 },
  );
  const byName = new Map<string, DiscoverEntry>();
  for (const entry of [
    ...curated.entries,
    ...(registry._tag === "Success" ? registry.success.entries : []),
  ])
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  return { entries: [...byName.values()], registry };
});

/** How many names a missed add offers in its place. */
const MAX_CANDIDATES = 3;

/**
 * An add names a connector exactly. A miss offers the closest names this agent may add, for
 * the agent to choose from: a guess is never added for it.
 */
const missedName = Effect.fn("ConnectorAgentControl.missedName")(function* (
  discover: ExtensionsDiscoverShape,
  from: string,
  elsewhere: ReadonlySet<string>,
) {
  const { entries } = yield* searchEntries(discover, from).pipe(
    Effect.orElseSucceed(() => ({ entries: [] as ReadonlyArray<DiscoverEntry> })),
  );
  const names = entries
    .filter(
      (entry) =>
        entry.installedConnectorId === undefined || !elsewhere.has(entry.installedConnectorId),
    )
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.name);
  return notFound(
    names.length === 0
      ? `Discover has nothing named ${from}. scient_connector_list {"query":"…"} finds its name.`
      : `Discover has nothing named exactly ${from}. Closest: ${names.join(", ")}. Add one by that name, or scient_connector_list {"query":"${from.replaceAll('"', "")}"} shows more.`,
  );
});

/** The user's connectors and, for a query, ones Scient can add (its own picks, then the Registry). */
export const listConnectors = Effect.fn("ConnectorAgentControl.list")(function* (input: {
  readonly query?: string | undefined;
  readonly connector?: string | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly projectId?: ProjectId | undefined;
}) {
  const { runtime, discover, observed } = yield* services;
  // A blank query or connector name is absent.
  const connectorName = input.connector?.trim() || undefined;
  const query = connectorName !== undefined ? undefined : input.query?.trim() || undefined;
  return yield* observed("connectors.agent.list", { searched: query !== undefined })(
    Effect.gen(function* () {
      const { connectors } = yield* runtime.list();
      const mine = connectors.filter((connector) =>
        forThisAgent(connector, input.providerInstanceId),
      );
      if (connectorName !== undefined) {
        const needle = connectorName.toLowerCase();
        const match =
          mine.find((item) => item.serverName.toLowerCase() === needle) ??
          mine.find((item) => item.displayName.toLowerCase() === needle);
        if (match === undefined) {
          return {
            connectors: [],
            message: `No connector named ${connectorName} is available to this agent.`,
          };
        }
        const projectAllowed =
          match.availability.type === "all-projects" ||
          (input.projectId !== undefined &&
            match.availability.projectIds.includes(input.projectId));
        if (!projectAllowed) {
          return {
            connectors: [rowOf(match)],
            message: `${match.displayName} is not enabled for this project. The user can enable it in Settings → Extensions.`,
          };
        }
        return {
          connectors: [rowOf(match)],
          message: nextStep(match, agentStatusOf(match)),
        };
      }
      const elsewhere = new Set(
        connectors.filter((item) => !mine.includes(item)).map((item) => item.connectorId),
      );
      const rows = mine.map(rowOf);
      if (query === undefined) return { connectors: rows };
      if (Option.isNone(discover))
        return { connectors: rows, found: [], message: "Discover is unavailable here." };
      const { entries, registry } = yield* searchEntries(discover.value, query);
      const cut =
        entries.length > MAX_FOUND ||
        (registry._tag === "Success" && registry.success.message !== undefined);
      return {
        connectors: rows,
        found: entries.slice(0, MAX_FOUND).map((entry) => foundRow(entry, mine, elsewhere)),
        ...(registry._tag === "Failure"
          ? {
              message: "The MCP Registry could not be searched just now; these are Scient's picks.",
            }
          : cut
            ? { message: `Showing the first ${MAX_FOUND} matches. Narrow the query to see others.` }
            : {}),
      };
    }),
    (listed) => ({
      connectors: listed.connectors.length,
      found: "found" in listed ? listed.found.length : 0,
    }),
  );
});

/** What the agent does next with a connector in this state. */
export const nextStep = (summary: ConnectorSummary, status: AgentConnectorStatus) => {
  const name = summary.displayName;
  const server = summary.serverName;
  switch (status) {
    case "needs-setup":
    case "needs-sign-in":
      return setupAdvice(summary);
    case "error":
      return `${name} has a problem: ${oneLine(summary.local?.problem ?? summary.lastError ?? "it did not start")} scient_connector_check {"connector":"${server}"} shows more${summary.local === undefined ? "" : "; scient_connector_copy fixes it"}.`;
    case "off":
      return `${name} is off: scient_connector_control {"connector":"${server}","action":"on"} turns it on.`;
    case "ready":
      return `New chats get its tools (they appear under ${server}). In this chat, call them through scient_connector_check {"connector":"${server}","calls":[{"tool":"…","arguments":{…}}]}.`;
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
      const caller = input.location?.providerInstanceId;
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
        const { connectors } = yield* runtime.list();
        const elsewhere = new Set(
          connectors.flatMap((item) => (forThisAgent(item, caller) ? [] : [item.connectorId])),
        );
        const found = yield* discover.value.entry({ name: from }).pipe(Effect.result);
        if (found._tag === "Failure")
          return yield* found.failure.reason === "not-found"
            ? yield* missedName(discover.value, from, elsewhere)
            : found.failure;
        const entry = found.success;
        const existing =
          entry.installedConnectorId === undefined
            ? undefined
            : findSummary(connectors, entry.installedConnectorId);
        // Given to other agents only: this agent learns no more than that, and adds no second copy.
        if (existing !== undefined && !forThisAgent(existing, caller))
          return yield* invalid(
            `${entry.title ?? entry.name} is already added for other agents. The person can choose this agent on its page in Settings → Extensions.`,
          );
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
      const added = yield* runtime.add({ ...request, changedBy: "agent" }).pipe(
        Effect.mapError((error) =>
          error.reason === "sign-in-failed" && request.credential?.type === "bound"
            ? rejectedKey(request.displayName ?? "The service", request.credential.secretRef)
            : error,
        ),
        // The runtime names the connector an address already belongs to; one given to other
        // agents only is not named to this one.
        Effect.catch((error) =>
          Effect.flatMap(runtime.list(), ({ connectors }) =>
            connectors.some(
              (item) => !forThisAgent(item, caller) && error.message.includes(item.displayName),
            )
              ? invalid(
                  "That service is already added for other agents. The person can choose this agent on its page in Settings → Extensions.",
                )
              : Effect.fail(error),
          ),
        ),
      );
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

/** A key the user entered that the service turned down, and how the agent has it replaced. */
const rejectedKey = (name: string, secretRef: string) => {
  const accountId = /^account:(.+):token$/u.exec(secretRef)?.[1];
  const replace =
    accountId === undefined
      ? "Ask the user to replace it in Settings → Accounts & secrets"
      : `scient_accounts_list shows it; scient_account_add {"accountId":"${accountId}","name":"${name}","reason":"${name} turned down the last key."} asks the user for a new one in the private card`;
  return invalid(
    `${name} turned down the API key the user entered in the private card; it is kept in Accounts. ${replace}, then call scient_connector_add again. Never ask for the key in chat.`,
  );
};

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
  /** The caller: its agent choice, and its project for a restart's start check. */
  location?: ConnectorLocation | undefined,
) {
  const { runtime, observed } = yield* services;
  return yield* observed("connectors.agent.control", { variant: input.action })(
    Effect.gen(function* () {
      const summary = yield* requireSummary(input.connector);
      if (!forThisAgent(summary, location?.providerInstanceId))
        return yield* invalid(notForThisAgent(input.connector));
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
          // Start it once, so "restarted" reports whether its current files actually start.
          const before = yield* now;
          if (agentStatusOf(before) !== "ready")
            return result(before, `${name} restarted. ${nextStep(before, agentStatusOf(before))}`);
          const started = yield* testedTools(before, location);
          const current = yield* now;
          if (started.problem !== undefined)
            return {
              ...result(current, ""),
              status: "error" as const,
              message: `${name} restarted, but it did not start: ${oneLine(started.problem)} scient_connector_check {"connector":"${server}"} shows more; scient_connector_copy fixes it.`,
            };
          return result(
            current,
            `${name} restarted and started with ${started.tools.length} tool${started.tools.length === 1 ? "" : "s"}${started.tools.length === 0 ? "" : ` (${started.tools.slice(0, 8).join(", ")}${started.tools.length > 8 ? ", …" : ""})`}.`,
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
                `Opened ${name}'s sign-in as the user's own tab in this chat's browser, in its default profile; your preview tools don't see the user's tabs, by design. Tell the user it is open: they finish it there, logging in to ${name} first if it asks, and Scient keeps the sign-in. Then scient_connector_check {"connector":"${server}"} lists its tools.`,
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

/**
 * The installed connector's own test, hosted or local: it starts (or is reached), lists its tools
 * and makes the agent's calls, so a connector added in this chat can be used in it.
 */
export const testConnector = Effect.fn("ConnectorAgentControl.test")(function* (
  name: string,
  location: ConnectorLocation | undefined,
  calls?: ReadonlyArray<{ readonly tool: string; readonly arguments?: unknown }>,
) {
  const { runtime, observed } = yield* services;
  return yield* observed("connectors.agent.check", { variant: "installed" })(
    Effect.gen(function* () {
      const summary = yield* requireSummary(name);
      // Before anything of its own is read: its setup and sign-in are not this agent's to learn.
      if (!forThisAgent(summary, location?.providerInstanceId))
        return { ok: false, tools: [], calls: [], missing: [], error: notForThisAgent(name) };
      const tested = yield* runtime.test({
        connectorId: summary.connectorId,
        location,
        ...(calls === undefined ? {} : { calls }),
      });
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
        calls: tested.calls ?? [],
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
