/**
 * Antigravity plugin sign-in, from the challenge a plugin's failed tool call prints. The live agy
 * process listens on the challenge's loopback redirect, so opening the page while it runs
 * finishes the sign-in there. Scient keeps the page server-side and never fetches it.
 */
import type { OrchestrationV2PluginSignIn, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import type * as EffectAcpSchema from "effect-acp/compat";

const CARD_PATTERN = /<plugin-card catalog-id="([a-z0-9][a-z0-9_-]{0,63})"><\/plugin-card>/u;
const SCHEME_PATTERN = /[a-z][a-z0-9+.-]*:\/\//giu;
const URL_TOKEN_PATTERN = /^[^\s<>"'`]+/u;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/giu;
const URL_STARTS = ["https://", "http://"];
const AUTHORIZATION_PARAMS = /[?&](?:redirect_uri|state|code_challenge)=/iu;
const MAX_TEXT_LENGTH = 32_000;
const MAX_URL_LENGTH = 4_096;
const MAX_HOLD = 8_192;
const MAX_STATE_LENGTH = 512;
const URL_SAFE_VALUE = /^[A-Za-z0-9._~-]+$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Unquoted shell syntax that would let a command print text the plugin's CLI did not.
const SHELL_CONTROL = /[;&|<>`$(){}\\\n\r]/u;

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  gdrive: "Google Drive",
  gdocs: "Google Docs",
  gsheets: "Google Sheets",
  gslides: "Google Slides",
  gcalendar: "Google Calendar",
};

export const LINK_REMOVED = "[sign-in link removed]";
const VALUE_REMOVED = "[removed]";

export interface PluginSignInChallenge {
  readonly plugin: string;
  readonly authorizationUrl: string;
  /** The page's origin and path, which the plugin's installed manifest must declare. */
  readonly endpoint: string;
  readonly clientId: string;
  /** Text to scrub wherever the agent repeats it. */
  readonly secrets: ReadonlyArray<string>;
}

const single = (params: URLSearchParams, name: string) => {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : undefined;
};

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const isLoopbackRedirect = (value: string) => {
  const redirect = parseUrl(value);
  return redirect !== undefined && LOOPBACK_HOSTS.has(redirect.hostname);
};

/** An HTTPS page with one client, one state and one loopback `/callback` redirect. */
function validatePluginAuthorizationUrl(raw: string): URL | undefined {
  if (raw.length > MAX_URL_LENGTH || raw.includes("#")) return undefined;
  const url = parseUrl(raw);
  if (
    url === undefined ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return undefined;
  }
  const state = single(url.searchParams, "state");
  const redirectUri = single(url.searchParams, "redirect_uri");
  const clientId = single(url.searchParams, "client_id");
  if (
    state === undefined ||
    state.length === 0 ||
    state.length > MAX_STATE_LENGTH ||
    !URL_SAFE_VALUE.test(state) ||
    clientId === undefined ||
    clientId.length === 0 ||
    redirectUri === undefined ||
    url.searchParams.getAll("code_challenge").length > 1
  ) {
    return undefined;
  }
  const redirect = parseUrl(redirectUri);
  const port = Number(redirect?.port);
  if (
    redirect === undefined ||
    redirect.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(redirect.hostname) ||
    !/^\d+$/u.test(redirect.port) ||
    port < 1024 ||
    port > 65_535 ||
    redirect.pathname !== "/callback" ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.search !== "" ||
    redirect.hash !== "" ||
    redirectUri.includes("#")
  ) {
    return undefined;
  }
  return url;
}

/**
 * The challenge in one tool result text: exactly one well-formed card, and exactly one URL,
 * which must be a valid sign-in page.
 */
export function extractPluginSignInChallenge(text: string): PluginSignInChallenge | undefined {
  if (text.length > MAX_TEXT_LENGTH) return undefined;
  if (text.split("plugin-card").length !== 3) return undefined;
  const plugin = CARD_PATTERN.exec(text)?.[1];
  if (plugin === undefined) return undefined;
  const schemes = [...text.matchAll(SCHEME_PATTERN)];
  if (schemes.length !== 1) return undefined;
  const token = URL_TOKEN_PATTERN.exec(text.slice(schemes[0]!.index))?.[0];
  if (token === undefined) return undefined;
  const url = validatePluginAuthorizationUrl(token);
  if (url === undefined) return undefined;
  const secrets = [token, url.searchParams.get("state"), url.searchParams.get("code_challenge")];
  return {
    plugin,
    authorizationUrl: token,
    endpoint: `${url.origin}${url.pathname}`,
    clientId: url.searchParams.get("client_id")!,
    secrets: secrets.filter((value): value is string => Predicate.isString(value) && value !== ""),
  };
}

function pluginDisplayName(plugin: string): string | undefined {
  return DISPLAY_NAMES[plugin];
}

/** A URL that sends a sign-in back to this computer; an unfinished one counts once it looks like one. */
function isSignInUrl(token: string, unfinished: boolean): boolean {
  const url = parseUrl(token);
  if (url?.searchParams.getAll("redirect_uri").some(isLoopbackRedirect) === true) return true;
  return unfinished && AUTHORIZATION_PARAMS.test(token);
}

/** Text with every sign-in URL and known secret replaced. */
function scrubSignInText(text: string, secrets: ReadonlyArray<string>, openEnd = false): string {
  let result = text.replace(URL_IN_TEXT, (token, offset: number) =>
    isSignInUrl(token, openEnd && offset + token.length === text.length) ? LINK_REMOVED : token,
  );
  for (const secret of secrets) {
    if (result.includes(secret)) result = result.split(secret).join(VALUE_REMOVED);
  }
  return result;
}

function collectStrings(value: unknown, into: Array<string>, depth = 0): void {
  if (depth > 12 || into.length > 256) return;
  if (Predicate.isString(value)) {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into, depth + 1);
  } else if (Predicate.isObject(value)) {
    for (const entry of Object.values(value)) collectStrings(entry, into, depth + 1);
  }
}

/** A copy of `value` with every string scrubbed, at any depth. */
function scrubPayload<A>(value: A, secrets: ReadonlyArray<string>): A {
  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > 16) return entry;
    if (Predicate.isString(entry)) return scrubSignInText(entry, secrets);
    if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
    if (Predicate.isObject(entry)) {
      return Object.fromEntries(
        Object.entries(entry).map(([key, item]) => [key, visit(item, depth + 1)]),
      );
    }
    return entry;
  };
  return visit(value, 0) as A;
}

/**
 * The one challenge a tool's result carries: its outputs must agree, and the call's own input
 * never contains the card or the state.
 */
export function extractToolCallChallenge(update: {
  readonly inputs: ReadonlyArray<unknown>;
  readonly outputs: ReadonlyArray<unknown>;
}): PluginSignInChallenge | undefined {
  const inputs: Array<string> = [];
  collectStrings(update.inputs, inputs);
  if (inputs.some((text) => text.includes("plugin-card"))) return undefined;
  const outputs: Array<string> = [];
  collectStrings(update.outputs, outputs);
  let found: PluginSignInChallenge | undefined;
  for (const text of outputs) {
    if (!text.includes("plugin-card")) continue;
    const challenge = extractPluginSignInChallenge(text);
    if (challenge === undefined) return undefined;
    if (found !== undefined && found.authorizationUrl !== challenge.authorizationUrl) {
      return undefined;
    }
    found = challenge;
  }
  if (found === undefined) return undefined;
  const state = found.secrets[1];
  if (state !== undefined && inputs.some((text) => text.includes(state))) return undefined;
  return found;
}

/** The program a plain shell command runs, or undefined when shell syntax could add output. */
export function plainCommandProgram(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 4_096 || SHELL_CONTROL.test(trimmed)) {
    return undefined;
  }
  return /^[A-Za-z0-9._-]+(?=\s|$)/u.exec(trimmed)?.[0];
}

/** The earliest index whose rest of `buffer` begins some text without completing it. */
function partialStart(buffer: string, texts: ReadonlyArray<string>): number {
  let earliest = -1;
  const lower = buffer.toLowerCase();
  for (const text of texts) {
    const from = Math.max(0, buffer.length - text.length + 1);
    for (let index = from; index < buffer.length; index++) {
      if (earliest !== -1 && index >= earliest) break;
      if (text.startsWith(text === text.toLowerCase() ? lower.slice(index) : buffer.slice(index))) {
        earliest = index;
        break;
      }
    }
  }
  return earliest;
}

/**
 * Scrubs text that arrives in chunks. A tail that could begin a sign-in URL, a known secret or a
 * card is held, bounded, until a later chunk completes it or the stream ends (`flush`).
 */
export function makeStreamRedactor(
  patterns: () => {
    readonly secrets: ReadonlyArray<string>;
    readonly cards: ReadonlyArray<string>;
  },
) {
  let carry = "";
  let previous = "\n";
  const holdPoint = (
    buffer: string,
    secrets: ReadonlyArray<string>,
    cards: ReadonlyArray<string>,
  ) => {
    let hold = buffer.length;
    for (const match of buffer.matchAll(URL_IN_TEXT)) {
      if (
        match.index + match[0].length === buffer.length &&
        buffer.length - match.index <= MAX_HOLD
      ) {
        hold = Math.min(hold, match.index);
      }
    }
    const partial = partialStart(buffer, [...URL_STARTS, ...secrets, ...cards]);
    if (partial !== -1) hold = Math.min(hold, partial);
    for (const card of cards) {
      if (buffer.endsWith(card)) hold = Math.min(hold, buffer.length - card.length);
    }
    return hold;
  };
  const dropStandaloneCards = (text: string, cards: ReadonlyArray<string>, next: string) => {
    let result = text;
    for (const card of cards) {
      let from = 0;
      for (;;) {
        const index = result.indexOf(card, from);
        if (index === -1) break;
        const before = index === 0 ? previous : result[index - 1];
        const after = result[index + card.length] ?? next;
        if (before === "\n" && (after === "\n" || after === "\r" || after === "")) {
          result = result.slice(0, index) + result.slice(index + card.length);
          from = index;
        } else {
          from = index + card.length;
        }
      }
    }
    return result;
  };
  const process = (buffer: string, final: boolean) => {
    const { secrets, cards } = patterns();
    const hold = final ? buffer.length : holdPoint(buffer, secrets, cards);
    const region = buffer.slice(0, hold);
    carry = buffer.slice(hold);
    const scrubbed = scrubSignInText(region, secrets, hold === buffer.length);
    const out = dropStandaloneCards(scrubbed, cards, final ? "" : (carry[0] ?? "\u0000"));
    if (out.length > 0) previous = out.at(-1)!;
    return out;
  };
  return {
    push: (chunk: string) => process(carry + chunk, false),
    flush: () => {
      const held = carry;
      carry = "";
      return held.length === 0 ? "" : process(held, true);
    },
  };
}

export interface PluginSignInOwner {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
}

/** A challenge seen in a plain run of a CLI; it offers a sign-in only once the plugin vouches for it. */
export interface PluginSignInCandidate {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly generation: number;
  /** The program the command ran. */
  readonly program: string;
  readonly challenge: PluginSignInChallenge;
}

interface Attempt {
  readonly id: string;
  readonly plugin: string;
  readonly displayName: string | undefined;
  readonly programs: ReadonlyArray<string>;
  readonly url: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly expiresAt: number;
  owner: PluginSignInOwner | undefined;
  live: boolean;
  signedIn: boolean;
}

interface TrackedTool {
  kind?: string | null | undefined;
  title?: string | null | undefined;
  rawInput?: unknown;
  streamed: string;
}

export type PluginSignInRedeemFailure = "expired" | "not-found";

export interface PluginSignInToolNotice {
  readonly title: string;
  readonly message: string;
  readonly level: "warning" | "info";
  readonly pluginSignIn: OrchestrationV2PluginSignIn;
}

type Notification = EffectAcpSchema.SessionNotification;
type ChunkUpdate = Extract<
  EffectAcpSchema.SessionUpdate,
  { readonly sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }
>;

const exitCodeOf = (rawOutput: unknown) => {
  if (!Predicate.isObject(rawOutput)) return undefined;
  const code = rawOutput.exit_code ?? rawOutput.exitCode;
  return Predicate.isNumber(code) ? code : undefined;
};

const commandOf = (rawInput: unknown) => {
  if (!Predicate.isObject(rawInput)) return undefined;
  const command =
    rawInput.CommandLine ?? rawInput.command_line ?? rawInput.commandLine ?? rawInput.command;
  return Predicate.isString(command) ? command : undefined;
};

const isTerminal = (status: string | null | undefined) =>
  status === "completed" || status === "failed";

/**
 * Challenges a live Antigravity adapter has seen. Every sign-in URL is scrubbed before
 * projection; an attempt exists only for a candidate the caller admitted, belongs to one agent
 * process generation and expires, and only the thread that showed it can open it.
 */
export function makeAntigravityPluginSignIns(
  options: {
    readonly ttlMs?: number;
    readonly maxAttempts?: number;
  } = {},
) {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const maxAttempts = options.maxAttempts ?? 64;
  const attempts = new Map<string, Attempt>();
  const pendingNotices = new Map<
    string,
    { readonly attemptId: string; readonly signedIn: boolean }
  >();
  const redactors = new Map<
    string,
    { readonly redactor: ReturnType<typeof makeStreamRedactor>; template: Notification }
  >();
  const tools = new Map<string, TrackedTool>();
  // Secrets of every challenge a session printed, admitted or not.
  const secretsBySession = new Map<string, Array<string>>();
  // Each session's latest agent process, so a prompt's end releases only its own held text.
  const sessionGenerations = new Map<string, number>();
  let nextGeneration = 0;

  const sessionPatterns = (sessionId: string) => () => ({
    secrets: secretsBySession.get(sessionId) ?? [],
    cards: [...attempts.values()]
      .filter((attempt) => attempt.sessionId === sessionId && attempt.live)
      .map((attempt) => `<plugin-card catalog-id="${attempt.plugin}"></plugin-card>`),
  });

  const rememberSecrets = (sessionId: string, secrets: ReadonlyArray<string>) => {
    const known = secretsBySession.get(sessionId) ?? [];
    for (const secret of secrets) if (!known.includes(secret)) known.push(secret);
    secretsBySession.set(sessionId, known.slice(-32));
  };

  /** Ends the session's streams that `ends` selects, releasing what they held, in order. */
  const flushStreams = (sessionId: string, ends: (channel: string) => boolean) => {
    const flushed: Array<Notification> = [];
    const prefix = `${sessionId}\u0000`;
    for (const [key, entry] of redactors) {
      if (!key.startsWith(prefix) || !ends(key.slice(prefix.length))) continue;
      redactors.delete(key);
      const text = entry.redactor.flush();
      if (text.length === 0) continue;
      const update = entry.template.update;
      flushed.push({
        ...entry.template,
        update:
          update.sessionUpdate === "tool_call_content_chunk"
            ? { ...update, content: { type: "content", content: { type: "text", text } } }
            : { ...(update as ChunkUpdate), content: { type: "text", text } },
      });
    }
    return flushed;
  };

  const streamChunk = (
    notification: Notification,
    channel: string,
    text: string,
    rebuild: (text: string) => Notification,
  ): ReadonlyArray<Notification> => {
    const key = `${notification.sessionId}\u0000${channel}`;
    let entry = redactors.get(key);
    if (entry === undefined) {
      entry = {
        redactor: makeStreamRedactor(sessionPatterns(notification.sessionId)),
        template: notification,
      };
      redactors.set(key, entry);
    }
    entry.template = notification;
    const emitted = entry.redactor.push(text);
    return emitted.length === 0 ? [] : [rebuild(emitted)];
  };

  const trackTool = (sessionId: string, toolCallId: string) => {
    const key = `${sessionId}\u0000${toolCallId}`;
    let tool = tools.get(key);
    if (tool === undefined) {
      tool = { streamed: "" };
      tools.set(key, tool);
      while (tools.size > 512) {
        const oldest = tools.keys().next().value;
        if (oldest === undefined) break;
        tools.delete(oldest);
      }
    }
    return { key, tool };
  };

  const evict = () => {
    while (attempts.size > maxAttempts) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
  };

  return {
    openGeneration: () => ++nextGeneration,
    /** The agent process ended; its listeners are gone, so its pages can no longer finish. */
    closeGeneration: (generation: number) => {
      for (const attempt of attempts.values()) {
        if (attempt.generation === generation) attempt.live = false;
      }
    },
    /**
     * The notifications to project in place of `notification`, with every sign-in URL and known
     * secret scrubbed, and the challenge a plain CLI run printed, for the caller to verify.
     */
    observe: (input: {
      readonly generation: number;
      readonly notification: Notification;
    }): {
      readonly notifications: ReadonlyArray<Notification>;
      readonly candidate: PluginSignInCandidate | undefined;
    } => {
      const { notification } = input;
      const update = notification.update;
      const sessionId = notification.sessionId;
      sessionGenerations.set(sessionId, input.generation);
      if (
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk") &&
        update.content.type === "text"
      ) {
        return {
          notifications: streamChunk(
            notification,
            update.sessionUpdate,
            update.content.text,
            (text) => ({
              ...notification,
              update: { ...update, content: { ...update.content, text } },
            }),
          ),
          candidate: undefined,
        };
      }
      if (update.sessionUpdate === "tool_call_content_chunk") {
        const content = update.content;
        if (content.type !== "content" || content.content.type !== "text") {
          return { notifications: [notification], candidate: undefined };
        }
        const { tool } = trackTool(sessionId, update.toolCallId);
        tool.streamed = (tool.streamed + content.content.text).slice(-MAX_TEXT_LENGTH);
        return {
          notifications: streamChunk(
            notification,
            `tool:${update.toolCallId}`,
            content.content.text,
            (text) => ({
              ...notification,
              update: { ...update, content: { ...content, content: { ...content.content, text } } },
            }),
          ),
          candidate: undefined,
        };
      }
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return { notifications: [notification], candidate: undefined };
      }
      // A tool's output stream ends with its call. Reply and thought streams keep their held
      // text across tool updates, so a status in between never releases half a sign-in link.
      const terminal = isTerminal(update.status);
      const flushed = flushStreams(
        sessionId,
        (channel) => terminal && channel === `tool:${update.toolCallId}`,
      );
      const { key, tool } = trackTool(sessionId, update.toolCallId);
      if (update.kind !== undefined) tool.kind = update.kind;
      if (update.title !== undefined) tool.title = update.title;
      if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
      const challenge = extractToolCallChallenge({
        inputs: [tool.title, tool.rawInput],
        outputs: [update.rawOutput, update.content, terminal ? tool.streamed : undefined],
      });
      const command = commandOf(tool.rawInput);
      let candidate: PluginSignInCandidate | undefined;
      if (challenge !== undefined) {
        rememberSecrets(sessionId, challenge.secrets);
        const program = command === undefined ? undefined : plainCommandProgram(command);
        if (tool.kind === "execute" && program !== undefined) {
          candidate = {
            sessionId,
            toolCallId: update.toolCallId,
            generation: input.generation,
            program,
            challenge,
          };
        }
      } else if (update.status === "completed" && exitCodeOf(update.rawOutput) === 0) {
        const program = command === undefined ? undefined : plainCommandProgram(command);
        const waiting = [...attempts.values()]
          .toReversed()
          .find(
            (attempt) =>
              attempt.sessionId === sessionId &&
              !attempt.signedIn &&
              program !== undefined &&
              attempt.programs.includes(program),
          );
        if (waiting !== undefined) {
          waiting.signedIn = true;
          waiting.live = false;
          pendingNotices.set(update.toolCallId, { attemptId: waiting.id, signedIn: true });
        }
      }
      if (terminal) tools.delete(key);
      const scrubbed = {
        ...notification,
        update: scrubPayload(update, secretsBySession.get(sessionId) ?? []),
      };
      return { notifications: [...flushed, scrubbed], candidate };
    },
    /** Offers the sign-in a verified candidate printed, replacing the plugin's older attempt. */
    admit: (
      candidate: PluginSignInCandidate,
      verified: {
        readonly attemptId: string;
        readonly displayName: string | undefined;
        readonly programs: ReadonlyArray<string>;
        readonly now: number;
      },
    ) => {
      const { challenge, sessionId } = candidate;
      let attempt = [...attempts.values()].find(
        (existing) =>
          existing.sessionId === sessionId && existing.url === challenge.authorizationUrl,
      );
      if (attempt === undefined) {
        for (const previous of attempts.values()) {
          if (previous.sessionId === sessionId && previous.plugin === challenge.plugin) {
            previous.live = false;
          }
        }
        attempt = {
          id: verified.attemptId,
          plugin: challenge.plugin,
          displayName: verified.displayName ?? pluginDisplayName(challenge.plugin),
          programs: verified.programs,
          url: challenge.authorizationUrl,
          sessionId,
          generation: candidate.generation,
          expiresAt: verified.now + ttlMs,
          owner: undefined,
          live: true,
          signedIn: false,
        };
        attempts.set(attempt.id, attempt);
        evict();
      }
      pendingNotices.set(candidate.toolCallId, { attemptId: attempt.id, signedIn: false });
    },
    /** Ends every stream of an agent process's sessions when its prompt ends. */
    flush: (generation: number) =>
      [...sessionGenerations]
        .filter(([, owner]) => owner === generation)
        .flatMap(([sessionId]) => flushStreams(sessionId, () => true)),
    /** The notice a tool call raised, once; it binds the attempt to the thread that shows it. */
    takeToolNotice: (
      toolCallId: string,
      owner: PluginSignInOwner,
    ): PluginSignInToolNotice | undefined => {
      const pending = pendingNotices.get(toolCallId);
      if (pending === undefined) return undefined;
      pendingNotices.delete(toolCallId);
      const attempt = attempts.get(pending.attemptId);
      if (attempt === undefined) return undefined;
      attempt.owner ??= owner;
      const name = attempt.displayName ?? attempt.plugin;
      const pluginSignIn = {
        attemptId: attempt.id,
        plugin: attempt.plugin,
        ...(attempt.displayName === undefined ? {} : { displayName: attempt.displayName }),
        ...(pending.signedIn ? { signedIn: true } : {}),
      };
      return pending.signedIn
        ? {
            title: `Signed in to ${name}`,
            message: `Antigravity used ${name} after the sign-in.`,
            level: "info",
            pluginSignIn,
          }
        : {
            title: `Sign in to ${name}`,
            message: `${name} needs a sign-in before Antigravity can use it.`,
            level: "warning",
            pluginSignIn,
          };
    },
    /** The sign-in page, only for the thread that showed the attempt while its agent still runs. */
    redeem: (input: {
      readonly attemptId: string;
      readonly owner: PluginSignInOwner;
      readonly nativeSessionId: string | undefined;
      readonly now: number;
    }): { readonly url: string } | { readonly failure: PluginSignInRedeemFailure } => {
      const attempt = attempts.get(input.attemptId);
      if (
        attempt === undefined ||
        attempt.owner === undefined ||
        attempt.owner.threadId !== input.owner.threadId ||
        attempt.owner.providerThreadId !== input.owner.providerThreadId ||
        attempt.sessionId !== input.nativeSessionId
      ) {
        return { failure: "not-found" };
      }
      if (!attempt.live || input.now >= attempt.expiresAt) return { failure: "expired" };
      return { url: attempt.url };
    },
  };
}

export type AntigravityPluginSignIns = ReturnType<typeof makeAntigravityPluginSignIns>;
