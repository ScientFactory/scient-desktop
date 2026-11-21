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
const MAX_TEXT_LENGTH = 32_000;
const MAX_URL_LENGTH = 4_096;
const MAX_STATE_LENGTH = 512;
const URL_SAFE_VALUE = /^[A-Za-z0-9._~-]+$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where a plugin may send the user to sign in, as `host/path`. Only Google's own plugins are
 * captured so far; a partner's endpoint joins once its challenge is recorded.
 */
const AUTHORIZATION_ENDPOINTS = new Set(["accounts.google.com/o/oauth2/v2/auth"]);

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
  /** Text to scrub wherever the agent repeats it. */
  readonly secrets: ReadonlyArray<string>;
}

const single = (params: URLSearchParams, name: string) => {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : undefined;
};

/** The sign-in page, when it is a known endpoint that redirects to a local agy listener. */
function validatePluginAuthorizationUrl(raw: string): URL | undefined {
  if (raw.length > MAX_URL_LENGTH || raw.includes("#")) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !AUTHORIZATION_ENDPOINTS.has(`${url.hostname}${url.pathname}`)
  ) {
    return undefined;
  }
  const state = single(url.searchParams, "state");
  const redirectUri = single(url.searchParams, "redirect_uri");
  if (
    state === undefined ||
    state.length === 0 ||
    state.length > MAX_STATE_LENGTH ||
    !URL_SAFE_VALUE.test(state) ||
    redirectUri === undefined ||
    url.searchParams.getAll("code_challenge").length > 1
  ) {
    return undefined;
  }
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return undefined;
  }
  const port = Number(redirect.port);
  if (
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
  const card = CARD_PATTERN.exec(text);
  const plugin = card?.[1];
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
    secrets: secrets.filter((value): value is string => Predicate.isString(value) && value !== ""),
  };
}

function pluginDisplayName(plugin: string): string | undefined {
  return DISPLAY_NAMES[plugin];
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

const replaceSecrets = (text: string, secrets: ReadonlyArray<string>) => {
  let result = text;
  for (const [index, secret] of secrets.entries()) {
    if (result.includes(secret)) {
      result = result.split(secret).join(index === 0 ? LINK_REMOVED : VALUE_REMOVED);
    }
  }
  return result;
};

/** A copy of `value` with every secret replaced, in any string at any depth. */
function redactPluginSignInSecrets<A>(value: A, secrets: ReadonlyArray<string>): A {
  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > 16) return entry;
    if (Predicate.isString(entry)) return replaceSecrets(entry, secrets);
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

/** The one challenge the tool's result carries; text the call was given never counts. */
export function extractToolCallChallenge(update: {
  readonly title?: string | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: unknown;
}): PluginSignInChallenge | undefined {
  const inputs: Array<string> = [];
  collectStrings([update.title, update.rawInput], inputs);
  if (inputs.some((text) => text.includes("plugin-card"))) return undefined;
  const outputs: Array<string> = [];
  collectStrings([update.rawOutput, update.content], outputs);
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

interface StreamPattern {
  readonly text: string;
  readonly replacement: string;
  /** Removed only on a line of its own. */
  readonly standalone?: boolean;
}

/** The earliest index whose rest of `buffer` begins some pattern without completing it. */
function partialStart(buffer: string, patterns: ReadonlyArray<StreamPattern>): number {
  let earliest = -1;
  for (const pattern of patterns) {
    const from = Math.max(0, buffer.length - pattern.text.length + 1);
    for (let index = from; index < buffer.length; index++) {
      if (earliest !== -1 && index >= earliest) break;
      if (pattern.text.startsWith(buffer.slice(index))) {
        earliest = index;
        break;
      }
    }
  }
  return earliest;
}

/**
 * Scrubs patterns from text that arrives in chunks. It holds back a tail that could begin a
 * pattern until the next chunk or `flush` decides it.
 */
export function makeStreamRedactor(patterns: () => ReadonlyArray<StreamPattern>) {
  let carry = "";
  let previous = "\n";
  const emit = (text: string) => {
    if (text.length > 0) previous = text.at(-1)!;
    return text;
  };
  const process = (input: string, final: boolean) => {
    const active = patterns();
    let buffer = input;
    let out = "";
    while (buffer.length > 0) {
      let match: { index: number; pattern: StreamPattern } | undefined;
      // A longer pattern still arriving holds its start, so a shorter one inside it waits.
      const partial = final ? -1 : partialStart(buffer, active);
      for (const pattern of active) {
        const index = buffer.indexOf(pattern.text);
        if (index !== -1 && (match === undefined || index < match.index)) {
          match = { index, pattern };
        }
      }
      if (match === undefined || (partial !== -1 && partial <= match.index)) break;
      const { index, pattern } = match;
      const before = buffer.slice(0, index);
      const end = index + pattern.text.length;
      if (pattern.standalone === true) {
        const lineStart = (before.length > 0 ? before.at(-1) : (out.at(-1) ?? previous)) === "\n";
        if (end === buffer.length && !final) {
          out += before;
          carry = buffer.slice(index);
          return emit(out);
        }
        const next = buffer[end];
        const lineEnd = next === undefined || next === "\n" || next === "\r";
        out += before + (lineStart && lineEnd ? pattern.replacement : pattern.text);
      } else {
        out += before + pattern.replacement;
      }
      buffer = buffer.slice(end);
    }
    const start = final ? -1 : partialStart(buffer, active);
    const hold = start === -1 ? 0 : buffer.length - start;
    out += buffer.slice(0, buffer.length - hold);
    carry = buffer.slice(buffer.length - hold);
    return emit(out);
  };
  return {
    push: (chunk: string) => process(carry + chunk, false),
    flush: () => {
      const held = carry;
      carry = "";
      return held.length === 0 ? "" : process(held, true);
    },
    get holding() {
      return carry.length > 0;
    },
  };
}

export interface PluginSignInOwner {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
}

interface Attempt {
  readonly id: string;
  readonly plugin: string;
  readonly url: string;
  readonly secrets: ReadonlyArray<string>;
  readonly sessionId: string;
  readonly generation: number;
  readonly expiresAt: number;
  owner: PluginSignInOwner | undefined;
  live: boolean;
  signedIn: boolean;
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

const commandRunsPlugin = (command: string, plugin: string) =>
  new RegExp(`(?:^|[;&|]\\s*)${plugin}(?:\\s|$)`, "u").test(command.trim());

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

/**
 * Challenges a live Antigravity adapter has seen. Attempts belong to one agent process
 * generation and expire; the notice names an attempt, and only its thread can open it.
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
  // Each session's latest agent process, so a prompt's end releases only its own held text.
  const sessionGenerations = new Map<string, number>();
  let nextGeneration = 0;

  const sessionPatterns = (sessionId: string) => (): ReadonlyArray<StreamPattern> => {
    const patterns: Array<StreamPattern> = [];
    for (const attempt of attempts.values()) {
      if (attempt.sessionId !== sessionId) continue;
      for (const [index, secret] of attempt.secrets.entries()) {
        patterns.push({ text: secret, replacement: index === 0 ? LINK_REMOVED : VALUE_REMOVED });
      }
      if (attempt.live) {
        patterns.push({
          text: `<plugin-card catalog-id="${attempt.plugin}"></plugin-card>`,
          replacement: "",
          standalone: true,
        });
      }
    }
    return patterns;
  };
  const sessionHasAttempts = (sessionId: string) =>
    [...attempts.values()].some((attempt) => attempt.sessionId === sessionId);
  const sessionSecrets = (sessionId: string) =>
    [...attempts.values()]
      .filter((attempt) => attempt.sessionId === sessionId)
      .flatMap((attempt) => attempt.secrets);

  /** Releases the held text of a session's channels other than `keep`. */
  const flushSession = (sessionId: string, keep?: string): ReadonlyArray<Notification> => {
    const flushed: Array<Notification> = [];
    for (const [key, entry] of redactors) {
      if (key === keep || !key.startsWith(`${sessionId}\u0000`)) continue;
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

  const evict = () => {
    while (attempts.size > maxAttempts) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
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
    const others = flushSession(notification.sessionId, key);
    const emitted = entry.redactor.push(text);
    return emitted.length === 0 ? others : [...others, rebuild(emitted)];
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
     * The notifications to project in place of `notification`: challenge URLs scrubbed, text
     * held back while it could begin one, and held text released before other updates.
     */
    observe: (input: {
      readonly generation: number;
      readonly notification: Notification;
      readonly now: number;
      readonly newId: () => string;
    }): ReadonlyArray<Notification> => {
      const { notification } = input;
      const update = notification.update;
      const sessionId = notification.sessionId;
      sessionGenerations.set(sessionId, input.generation);
      if (
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk") &&
        update.content.type === "text"
      ) {
        if (
          !sessionHasAttempts(sessionId) &&
          !redactors.has(`${sessionId}\u0000${update.sessionUpdate}`)
        ) {
          return [notification];
        }
        return streamChunk(notification, update.sessionUpdate, update.content.text, (text) => ({
          ...notification,
          update: { ...update, content: { ...update.content, text } },
        }));
      }
      if (update.sessionUpdate === "tool_call_content_chunk") {
        const content = update.content;
        if (
          content.type === "content" &&
          content.content.type === "text" &&
          sessionHasAttempts(sessionId)
        ) {
          return streamChunk(
            notification,
            `tool:${update.toolCallId}`,
            content.content.text,
            (text) => ({
              ...notification,
              update: { ...update, content: { ...content, content: { ...content.content, text } } },
            }),
          );
        }
        return [...flushSession(sessionId), notification];
      }
      const flushed = flushSession(sessionId);
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return [...flushed, notification];
      }
      const challenge = extractToolCallChallenge(update);
      if (challenge !== undefined) {
        let attempt = [...attempts.values()].find(
          (candidate) =>
            candidate.sessionId === sessionId && candidate.url === challenge.authorizationUrl,
        );
        if (attempt === undefined) {
          for (const previous of attempts.values()) {
            if (previous.sessionId === sessionId && previous.plugin === challenge.plugin) {
              previous.live = false;
            }
          }
          attempt = {
            id: input.newId(),
            plugin: challenge.plugin,
            url: challenge.authorizationUrl,
            secrets: challenge.secrets,
            sessionId,
            generation: input.generation,
            expiresAt: input.now + ttlMs,
            owner: undefined,
            live: true,
            signedIn: false,
          };
          attempts.set(attempt.id, attempt);
          evict();
        }
        pendingNotices.set(update.toolCallId, { attemptId: attempt.id, signedIn: false });
      } else if (update.status === "completed" && exitCodeOf(update.rawOutput) === 0) {
        const command = commandOf(update.rawInput);
        const waiting = [...attempts.values()]
          .toReversed()
          .find(
            (attempt) =>
              attempt.sessionId === sessionId &&
              !attempt.signedIn &&
              command !== undefined &&
              commandRunsPlugin(command, attempt.plugin),
          );
        if (waiting !== undefined) {
          waiting.signedIn = true;
          waiting.live = false;
          pendingNotices.set(update.toolCallId, { attemptId: waiting.id, signedIn: true });
        }
      }
      const secrets = sessionSecrets(sessionId);
      const scrubbed =
        secrets.length === 0
          ? notification
          : { ...notification, update: redactPluginSignInSecrets(update, secrets) };
      return [...flushed, scrubbed];
    },
    /** Held text of an agent process's sessions, released when its prompt ends. */
    flush: (generation: number) =>
      [...sessionGenerations]
        .filter(([, owner]) => owner === generation)
        .flatMap(([sessionId]) => flushSession(sessionId)),
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
      const displayName = pluginDisplayName(attempt.plugin);
      const name = displayName ?? attempt.plugin;
      const pluginSignIn = {
        attemptId: attempt.id,
        plugin: attempt.plugin,
        ...(displayName === undefined ? {} : { displayName }),
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
