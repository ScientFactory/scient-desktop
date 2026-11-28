/**
 * The user's WhatsApp as a linked device: one link per Scient server, kept by one supervised
 * `wacli sync --follow` while linked. Linking, cancelling and unlinking are serialized; the link
 * and the connection run as fibers of this layer. See docs/internals/scient-whatsapp.md.
 */
import {
  type WhatsAppLinkState,
  type WhatsAppStatus,
  WhatsAppError,
  WhatsAppToolError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { WacliInstall } from "./WacliInstall.ts";
import { callDelegate, delegateAddress } from "./wacliDelegate.ts";
import {
  classifyLinkFailure,
  eventMessage,
  eventMessagesSynced,
  eventQrCode,
  isSessionRevoked,
  isTemporaryBan,
  temporaryBanUntil,
  type WacliEvent,
} from "./wacliEvents.ts";
import {
  accountFromJid,
  readChats,
  readContacts,
  readDelegateReply,
  readDoctor,
  readEnvelope,
  readFailure,
  readMessages,
  recipientFor,
  sendFailure,
  sendUncertainError,
  type WacliEnvelope,
} from "./wacliJson.ts";
import {
  runWacli,
  runWacliWithEvents,
  wacliEnvironment,
  WacliProcessError,
  type WacliOutput,
} from "./wacliProcess.ts";
import { WhatsAppService } from "./WhatsAppService.ts";

const READ_TIMEOUT = Duration.seconds(30);
/** `doctor --connect` waits for WhatsApp's login verdict. */
const PROBE_TIMEOUT = Duration.seconds(90);
/** The running sync's budget for one send: queueing, pacing and the send itself. */
const SEND_BUDGET_MS = 90_000;
/** Keep the connection a moment after a send, so retry receipts are handled (wacli's default). */
const POST_SEND_WAIT_MS = 2_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4096;
/** Below the 104-byte Unix socket path limit on macOS (108 on Linux). */
const SOCKET_PATH_LIMIT = 100;
/** Agent calls in flight at once; unlinking takes them all, so it waits for the rest to finish. */
const AGENT_CALLS = 64;
/** Restart backoff for the connection: doubled per quick failure, capped. */
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A run that lasted this long resets the backoff. */
const HEALTHY_RUN_MS = 60_000;
/** When WhatsApp restricts the account without saying for how long. */
const UNKNOWN_RESTRICTION_MS = 24 * 60 * 60_000;
// wacli's follow loop reconnects without WhatsApp's login verdict, so a temporary ban never
// reaches its events. It gives up after five minutes; `doctor --connect` then asks for the verdict.
const SYNC_ARGS = [
  "sync",
  "--follow",
  "--events",
  "--max-reconnect=5m",
  "--stale-threshold=2m",
  "--presence-mode=quiet",
  "--send-spacing=3s-8s",
] as const;
const AUTH_ARGS = ["auth", "--qr-format=text", "--events", "--idle-exit=30s"] as const;

/** A restriction outlives Scient: it is read back before the next connection. */
const SavedRestriction = Schema.fromJsonString(
  Schema.Struct({
    until: Schema.Finite,
    /** WhatsApp said when it ends; otherwise `until` is Scient's own wait. */
    stated: Schema.Boolean,
  }),
);
const decodeSavedRestriction = Schema.decodeUnknownEffect(SavedRestriction);

type Services =
  | WacliInstall
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

const notConnected = new WhatsAppToolError({
  code: "not-connected",
  message: "WhatsApp isn't connected right now. Try again in a minute.",
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const install = yield* WacliInstall;
  const config = yield* ServerConfig.ServerConfig;
  const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
  const hostEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<Services>();

  const whatsappDir = path.join(config.stateDir, "whatsapp");
  const storeDir = path.join(whatsappDir, "store");
  const restrictionPath = path.join(whatsappDir, "restriction.json");
  const deviceName = descriptor.label;

  // wacli opens its delegate socket inside the store, and macOS and Linux cap socket paths near
  // 104 bytes. A store whose socket path is too long is reached through a short link, kept in a
  // folder only this user owns (never directly in a shared /tmp). Windows uses a named pipe.
  const socketPathFits =
    platform === "win32" ||
    new TextEncoder().encode(path.join(storeDir, ".send.sock")).length <= SOCKET_PATH_LIMIT;
  const shortRoot = path.join(
    hostEnvironment.XDG_RUNTIME_DIR ?? hostEnvironment.TMPDIR ?? "/tmp",
    `scient-whatsapp-${userId ?? "user"}`,
  );
  const wacliStoreDir = socketPathFits
    ? storeDir
    : path.join(shortRoot, (Hash.string(storeDir) >>> 0).toString(36));
  const env = wacliEnvironment({
    hostEnvironment,
    storeDir: wacliStoreDir,
    deviceLabel: deviceName,
  });
  const storeLinkFailed = new WacliProcessError({ reason: "failed", command: "store link" });
  /** Temp folders get cleaned, so the link is checked before every run; nothing runs without it. */
  const ensureStoreLink =
    wacliStoreDir === storeDir
      ? Effect.void
      : Effect.gen(function* () {
          yield* fileSystem.makeDirectory(shortRoot, { mode: 0o700 }).pipe(Effect.ignore);
          const root = yield* fileSystem.lstat(shortRoot);
          const owner = Option.getOrUndefined(root.uid);
          if (root.type !== "Directory" || (userId !== undefined && owner !== userId)) {
            return yield* storeLinkFailed;
          }
          if ((root.mode & 0o077) !== 0) yield* fileSystem.chmod(shortRoot, 0o700);
          const target = yield* fileSystem
            .readLink(wacliStoreDir)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (target === storeDir) return;
          if (target !== undefined) yield* fileSystem.remove(wacliStoreDir);
          yield* fileSystem.symlink(storeDir, wacliStoreDir);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("whatsapp: could not link the store at a short path", {
              cause,
            }).pipe(Effect.andThen(Effect.fail(storeLinkFailed))),
          ),
        );

  const state = yield* SubscriptionRef.make<WhatsAppLinkState>({ _tag: "Unlinked" });
  const ready = yield* Deferred.make<void>();
  /** Linking, cancelling and unlinking one at a time. */
  const control = yield* Semaphore.make(1);
  /** Agent calls hold one permit each; unlinking holds them all. */
  const agentCalls = yield* Semaphore.make(AGENT_CALLS);
  const unlinking = yield* Ref.make(false);
  const linkFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const connectionFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  /** The linked number, kept through a restriction for when it ends. */
  const linkedAccount = yield* Ref.make("");

  const toStatus = (current: WhatsAppLinkState): WhatsAppStatus => ({
    state: current,
    deviceName,
    platformSupported: install.supported,
  });
  const setState = (next: WhatsAppLinkState) => SubscriptionRef.set(state, next);
  /** Change the connection of a link that is still `Linked`; anything else has moved on. */
  const setConnection = (
    connection: "connected" | "connecting" | "offline",
    lastActivityAt?: number,
  ) =>
    SubscriptionRef.update(state, (current) =>
      current._tag === "Linked"
        ? {
            ...current,
            connection,
            ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
          }
        : current,
    );
  const setLinked = (account: string) =>
    Ref.set(linkedAccount, account).pipe(
      Effect.andThen(setState({ _tag: "Linked", account, connection: "connecting" })),
    );

  const fork = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    effect.pipe(Effect.provideContext(context), Effect.forkIn(scope));

  const executable = install.executable;
  const command = (args: ReadonlyArray<string>, name: string) =>
    Effect.andThen(
      ensureStoreLink,
      Effect.map(executable, (exe) => ({ executable: exe, args, env, command: name })),
    );

  const ensureStoreDir = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(whatsappDir, { recursive: true });
    yield* fileSystem.makeDirectory(storeDir, { recursive: true, mode: 0o700 });
    // `makeDirectory`'s mode is masked by umask and skipped for an existing directory.
    yield* fileSystem.chmod(storeDir, 0o700).pipe(Effect.ignore);
  });
  const removeStore = fileSystem
    .remove(storeDir, { recursive: true, force: true })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("whatsapp: could not remove the local store", { cause }),
      ),
    );
  const storeExists = fileSystem.exists(storeDir).pipe(Effect.orElseSucceed(() => false));

  const savedRestriction = fileSystem.readFileString(restrictionPath).pipe(
    Effect.flatMap(decodeSavedRestriction),
    Effect.orElseSucceed(() => undefined),
  );
  const saveRestriction = (until: number, stated: boolean) =>
    fileSystem
      .writeFileString(restrictionPath, JSON.stringify({ until, stated }))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("whatsapp: could not save the restriction", { cause }),
        ),
      );
  const clearRestriction = fileSystem.remove(restrictionPath, { force: true }).pipe(Effect.ignore);

  /** The envelope wacli printed: on stdout when it succeeded, after warnings on stderr when not. */
  const envelopeOf = (output: WacliOutput): WacliEnvelope | undefined =>
    readEnvelope(output.stdout) ?? readEnvelope(output.stderr);

  const doctor = Effect.gen(function* () {
    const output = yield* runWacli({
      ...(yield* command(["--read-only", "--json", "doctor"], "doctor")),
      timeout: READ_TIMEOUT,
      maxStdoutBytes: MAX_STDOUT_BYTES,
    });
    const envelope = envelopeOf(output);
    return envelope?.success === true ? readDoctor(envelope.data) : undefined;
  });

  /** A real login, for WhatsApp's verdict on it; empty when it could not run. */
  const loginVerdict = Effect.gen(function* () {
    const output = yield* runWacli({
      ...(yield* command(["--json", "doctor", "--connect"], "doctor --connect")),
      timeout: PROBE_TIMEOUT,
      maxStdoutBytes: MAX_STDOUT_BYTES,
    });
    return `${envelopeOf(output)?.error ?? ""}\n${output.stderr}`;
  }).pipe(Effect.orElseSucceed(() => ""));

  /** True when WhatsApp confirmed the logout. */
  const logout = Effect.gen(function* () {
    const output = yield* runWacli({
      ...(yield* command(["--json", "auth", "logout"], "auth logout")),
      timeout: READ_TIMEOUT,
      maxStdoutBytes: MAX_STDOUT_BYTES,
    });
    return output.exitCode === 0 && envelopeOf(output)?.success !== false;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("whatsapp: logout did not run", { cause }).pipe(Effect.as(false)),
    ),
  );

  // ── Connection ────────────────────────────────────────────────────────────

  /** One `sync --follow` run, until it exits: what ended it. */
  const syncOnce = Effect.gen(function* () {
    let removed = false;
    let restrictedUntil: number | undefined;
    let restricted = false;
    const onEvent = Effect.fn("WhatsApp.syncEvent")(function* (event: WacliEvent) {
      const now = event.ts ?? (yield* Clock.currentTimeMillis);
      switch (event.event) {
        case "connected":
          yield* setConnection("connected", now);
          return;
        case "reconnecting":
        case "disconnected":
        case "stream_replaced":
        case "stale":
          yield* setConnection("connecting");
          return;
        case "logged_out":
          removed = true;
          return;
        case "error": {
          const message = eventMessage(event) ?? "";
          if (isTemporaryBan(message)) {
            restricted = true;
            restrictedUntil = temporaryBanUntil(message, now);
          } else if (isSessionRevoked(message)) {
            removed = true;
          }
          // wacli's errors name connections, files and WhatsApp's answers, not message content.
          yield* Effect.logWarning("whatsapp: connection error", {
            message: message.slice(0, 500),
          });
          return;
        }
      }
    });
    const exitCode = yield* runWacliWithEvents({
      ...(yield* command(SYNC_ARGS, "sync")),
      onEvent,
    });
    return { exitCode, removed, restricted, restrictedUntil };
  });

  /** Show the restriction and wait it out; nothing connects before it ends. */
  const waitOutRestriction = Effect.fn("WhatsApp.waitOutRestriction")(function* (
    until: number,
    stated: boolean,
  ) {
    yield* saveRestriction(until, stated);
    const account = yield* Ref.get(linkedAccount);
    yield* setState({
      _tag: "Restricted",
      ...(account === "" ? {} : { account }),
      ...(stated ? { until } : {}),
    });
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.sleep(Duration.millis(Math.max(0, until - now)));
    yield* clearRestriction;
    yield* setLinked(account === "" ? "+" : account);
  });

  const connectionLoop = Effect.gen(function* () {
    const saved = yield* savedRestriction;
    if (saved !== undefined && saved.until > (yield* Clock.currentTimeMillis)) {
      yield* waitOutRestriction(saved.until, saved.stated);
    }
    let backoff = BACKOFF_FIRST_MS;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* syncOnce.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("whatsapp: connection could not run", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      let removed = result?.removed === true;
      let restricted = result?.restricted === true;
      let restrictedUntil = result?.restrictedUntil;
      if (!removed && !restricted) {
        const verdict = yield* loginVerdict;
        const now = yield* Clock.currentTimeMillis;
        if (isTemporaryBan(verdict)) {
          restricted = true;
          restrictedUntil = temporaryBanUntil(verdict, now);
        } else if (isSessionRevoked(verdict)) {
          removed = true;
        }
      }
      if (removed) {
        yield* clearRestriction;
        yield* setState({ _tag: "RemovedByPhone" });
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      if (restricted) {
        yield* waitOutRestriction(
          restrictedUntil ?? now + UNKNOWN_RESTRICTION_MS,
          restrictedUntil !== undefined,
        );
        backoff = BACKOFF_FIRST_MS;
        continue;
      }
      yield* setConnection("connecting");
      backoff = now - startedAt >= HEALTHY_RUN_MS ? BACKOFF_FIRST_MS : backoff;
      yield* Effect.logInfo("whatsapp: connection stopped; restarting", {
        exitCode: result?.exitCode,
        retryInMs: backoff,
      });
      yield* Effect.sleep(Duration.millis(backoff));
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  });

  const stopFiber = Effect.fn("WhatsApp.stopFiber")(function* (
    ref: Ref.Ref<Fiber.Fiber<void> | undefined>,
  ) {
    const fiber = yield* Ref.getAndSet(ref, undefined);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
  });

  const startConnection = Effect.gen(function* () {
    yield* stopFiber(connectionFiber);
    yield* Ref.set(connectionFiber, yield* fork(connectionLoop));
  });

  // ── Linking ───────────────────────────────────────────────────────────────

  const linkOnce = Effect.gen(function* () {
    const exe = yield* executable.pipe(
      Effect.catchTags({
        WacliInstallError: (error) =>
          setState({ _tag: "Failed", reason: error.reason, message: error.message }).pipe(
            Effect.as(undefined),
          ),
      }),
    );
    if (exe === undefined) return;
    yield* ensureStoreDir;
    yield* ensureStoreLink;
    let paired = false;
    let failure: string | undefined;
    const exitCode = yield* runWacliWithEvents({
      executable: exe,
      args: AUTH_ARGS,
      env,
      command: "auth",
      onEvent: Effect.fn("WhatsApp.linkEvent")(function* (event: WacliEvent) {
        switch (event.event) {
          case "qr_code": {
            const qr = eventQrCode(event);
            if (qr !== undefined)
              yield* setState({
                _tag: "AwaitingScan",
                qr,
                issuedAt: event.ts ?? (yield* Clock.currentTimeMillis),
              });
            return;
          }
          case "connected":
          case "history_sync":
          case "progress": {
            paired = true;
            const synced = eventMessagesSynced(event);
            const current = yield* SubscriptionRef.get(state);
            const previous = current._tag === "Syncing" ? current.messagesSynced : 0;
            yield* setState({ _tag: "Syncing", messagesSynced: synced ?? previous });
            return;
          }
          case "error":
            failure = eventMessage(event) ?? failure;
            return;
        }
      }),
    });
    // Finish under the control lock so a cancel or unlink sees either linking or the outcome.
    yield* control.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(linkFiber, undefined);
        const linked = exitCode === 0 && paired ? yield* doctor : undefined;
        const account = linked?.authenticated ? accountFromJid(linked.linked_jid) : undefined;
        if (linked?.authenticated && linked.session_revoked !== true && account !== undefined) {
          yield* setLinked(account);
          yield* startConnection;
          return;
        }
        // A scanned link that did not finish still sits on the phone: log it out before forgetting it.
        if (paired) yield* logout;
        yield* removeStore;
        if (failure !== undefined) {
          yield* Effect.logWarning("whatsapp: linking failed", { message: failure.slice(0, 500) });
        }
        const { reason, message } = classifyLinkFailure(failure);
        yield* setState({ _tag: "Failed", reason, message });
      }),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("whatsapp: linking failed", { cause });
        yield* Ref.set(linkFiber, undefined);
        yield* removeStore;
        const { reason, message } = classifyLinkFailure(undefined);
        yield* setState({ _tag: "Failed", reason, message });
      }),
    ),
  );

  const currentStatus = Effect.map(SubscriptionRef.get(state), toStatus);

  const startLink = control.withPermits(1)(
    Effect.gen(function* () {
      yield* Deferred.await(ready);
      const current = yield* SubscriptionRef.get(state);
      switch (current._tag) {
        case "Installing":
        case "AwaitingScan":
        case "Syncing":
        case "Linked":
        case "Restricted":
          return toStatus(current);
      }
      if (!install.supported) {
        return yield* new WhatsAppError({
          message: "WhatsApp linking is not available on this computer yet.",
        });
      }
      yield* stopFiber(connectionFiber);
      yield* removeStore;
      yield* clearRestriction;
      yield* setState({ _tag: "Installing" });
      yield* Ref.set(linkFiber, yield* fork(linkOnce));
      return yield* currentStatus;
    }),
  );

  const cancelLink = control.withPermits(1)(
    Effect.gen(function* () {
      const fiber = yield* Ref.getAndSet(linkFiber, undefined);
      if (fiber === undefined) return yield* currentStatus;
      // Once scanned, the phone already lists this computer: log it out before forgetting it.
      const scanned = (yield* SubscriptionRef.get(state))._tag === "Syncing";
      yield* Fiber.interrupt(fiber);
      if (scanned) yield* logout;
      yield* removeStore;
      yield* setState({ _tag: "Unlinked" });
      return yield* currentStatus;
    }),
  );

  const unlinkNow = Effect.gen(function* () {
    const previous = yield* SubscriptionRef.get(state);
    yield* stopFiber(linkFiber);
    yield* stopFiber(connectionFiber);
    let loggedOut = true;
    if (yield* storeExists) {
      loggedOut = yield* logout;
      // Unlinking promises the chats are gone from this computer: say so when they are not.
      yield* fileSystem.remove(storeDir, { recursive: true, force: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("whatsapp: could not delete the local store", { cause });
            const message = "Scient couldn't delete its copy of your chats. Unlink again.";
            yield* setState({ _tag: "Failed", reason: "unlink-incomplete", message });
            return yield* new WhatsAppError({ message });
          }),
        ),
      );
    }
    if (wacliStoreDir !== storeDir) {
      yield* fileSystem.remove(wacliStoreDir, { force: true }).pipe(Effect.ignore);
    }
    yield* clearRestriction;
    yield* setState({ _tag: "Unlinked" });
    // A phone that already removed the device has nothing left to log out.
    if (!loggedOut && previous._tag !== "RemovedByPhone") {
      return yield* new WhatsAppError({
        message: `Scient deleted its copy of your chats but couldn't reach WhatsApp to log out. On your phone, remove “${deviceName}” from Linked devices.`,
      });
    }
    return yield* currentStatus;
  });

  const unlink = control.withPermits(1)(
    Effect.gen(function* () {
      yield* Deferred.await(ready);
      // No new agent call starts, and the ones running finish, before the link goes away.
      yield* Ref.set(unlinking, true);
      return yield* agentCalls.withPermits(AGENT_CALLS)(unlinkNow);
    }).pipe(Effect.ensuring(Ref.set(unlinking, false))),
  );

  // ── Agent operations ──────────────────────────────────────────────────────

  const requireLink = Effect.gen(function* () {
    yield* Deferred.await(ready);
    const current = yield* SubscriptionRef.get(state);
    if (yield* Ref.get(unlinking)) {
      return yield* new WhatsAppToolError({
        code: "not-linked",
        message: "WhatsApp is being unlinked.",
      });
    }
    switch (current._tag) {
      case "Linked":
        return current;
      case "Restricted":
        return yield* new WhatsAppToolError({
          code: "restricted",
          message:
            current.until === undefined
              ? "WhatsApp has temporarily restricted this account."
              : `WhatsApp has temporarily restricted this account until ${DateTime.formatIso(DateTime.makeUnsafe(current.until))}.`,
        });
      case "RemovedByPhone":
        return yield* new WhatsAppToolError({
          code: "removed-by-phone",
          message:
            "The phone removed Scient from Linked devices. The user can link again in Settings → Extensions → WhatsApp.",
        });
      default:
        return yield* new WhatsAppToolError({
          code: "not-linked",
          message: "WhatsApp is not linked. The user links it in Settings → Extensions → WhatsApp.",
        });
    }
  });

  /** One agent call: it runs to the end before an unlink takes the link away. */
  const asAgentCall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    agentCalls.withPermits(1)(effect).pipe(Effect.provideContext(context));

  const failedRead = new WhatsAppToolError({
    code: "failed",
    message: "WhatsApp couldn't read the chats.",
  });

  const read = Effect.fn("WhatsApp.read")(function* <A>(
    args: ReadonlyArray<string>,
    name: string,
    map: (data: unknown) => A,
  ) {
    yield* requireLink;
    const output = yield* Effect.flatMap(command(["--read-only", "--json", ...args], name), (cmd) =>
      runWacli({ ...cmd, timeout: READ_TIMEOUT, maxStdoutBytes: MAX_STDOUT_BYTES }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("whatsapp: read failed to run", { command: name, cause }).pipe(
          Effect.andThen(Effect.fail(failedRead)),
        ),
      ),
    );
    const envelope = envelopeOf(output);
    if (envelope?.success === true) return map(envelope.data);
    return yield* readFailure(envelope?.error ?? "");
  }, asAgentCall);

  const optional = (flag: string, value: string | undefined) =>
    value === undefined || value === "" ? [] : [`--${flag}=${value}`];

  const delegateAddressNow = Effect.gen(function* () {
    yield* ensureStoreLink;
    return delegateAddress({
      platform,
      storeDir: wacliStoreDir,
      realStoreDir: platform === "win32" ? yield* fileSystem.realPath(storeDir) : storeDir,
      join: path.join,
    });
  });

  const service = WhatsAppService.of({
    status: Deferred.await(ready).pipe(Effect.andThen(currentStatus)),
    changes: Stream.unwrap(
      Deferred.await(ready).pipe(
        Effect.as(SubscriptionRef.changes(state).pipe(Stream.map(toStatus), Stream.changes)),
      ),
    ),
    startLink: startLink.pipe(Effect.provideContext(context)),
    cancelLink: cancelLink.pipe(Effect.provideContext(context)),
    unlink: unlink.pipe(Effect.provideContext(context)),
    listChats: Effect.fn("WhatsAppService.listChats")(function* ({ query, unreadOnly, limit }) {
      return yield* read(
        [
          "chats",
          "list",
          `--limit=${limit}`,
          ...optional("query", query),
          ...(unreadOnly ? ["--unread"] : []),
        ],
        "chats list",
        readChats,
      );
    }),
    listMessages: Effect.fn("WhatsAppService.listMessages")(function* ({
      chat,
      limit,
      before,
      after,
    }) {
      return yield* read(
        [
          "messages",
          "list",
          `--chat=${chat}`,
          `--limit=${limit}`,
          ...optional("before", before),
          ...optional("after", after),
        ],
        "messages list",
        readMessages,
      );
    }),
    searchMessages: Effect.fn("WhatsAppService.searchMessages")(function* ({ query, chat, limit }) {
      return yield* read(
        ["messages", "search", `--limit=${limit}`, ...optional("chat", chat), "--", query],
        "messages search",
        readMessages,
      );
    }),
    searchContacts: Effect.fn("WhatsAppService.searchContacts")(function* ({ query, limit }) {
      return yield* read(
        ["contacts", "search", `--limit=${limit}`, "--", query],
        "contacts search",
        readContacts,
      );
    }),
    sendText: Effect.fn("WhatsAppService.sendText")(function* ({ to, text, replyTo }) {
      if (text.trim() === "" || text.length > MAX_TEXT_LENGTH) {
        return yield* new WhatsAppToolError({
          code: "invalid-input",
          message: `The message must have between 1 and ${MAX_TEXT_LENGTH} characters.`,
        });
      }
      const recipient = recipientFor(to);
      if (recipient === undefined) {
        return yield* new WhatsAppToolError({
          code: "invalid-input",
          message:
            "Send to one person or group: a phone number, or a JID ending in @s.whatsapp.net, @lid or @g.us. Status updates, broadcast lists and channels aren't supported.",
        });
      }
      const link = yield* requireLink;
      if (link.connection !== "connected") return yield* notConnected;
      const address = yield* delegateAddressNow.pipe(
        Effect.catchCause(() => Effect.fail(notConnected)),
      );
      const now = yield* Clock.currentTimeMillis;
      const outcome = yield* callDelegate(
        address,
        {
          version: 1,
          kind: "text",
          to: recipient,
          message: text,
          ...(replyTo === undefined ? {} : { reply_to: replyTo }),
          no_preview: true,
          timeout_ms: SEND_BUDGET_MS,
          deadline_unix_ms: now + SEND_BUDGET_MS,
          post_send_wait_ms: POST_SEND_WAIT_MS,
        },
        SEND_BUDGET_MS + POST_SEND_WAIT_MS + 10_000,
      );
      switch (outcome._tag) {
        case "Unavailable":
          return yield* notConnected;
        case "Lost":
          return yield* sendUncertainError();
      }
      const reply = readDelegateReply(outcome.reply);
      if (reply?.ok === true && reply.id) return { messageId: reply.id, to: reply.to ?? recipient };
      if (reply === undefined || reply.ok) return yield* sendUncertainError();
      return yield* sendFailure(reply.error ?? "", recipient);
    }, asAgentCall),
  });

  // Startup: an existing store is a link to resume. Nothing runs, and nothing downloads, without
  // one; and nothing is deleted on a check that could not tell.
  yield* fork(
    Effect.gen(function* () {
      if (!(yield* storeExists)) return;
      const linked = yield* doctor.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("whatsapp: could not read the saved link", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      const account = accountFromJid(linked?.linked_jid);
      if (linked?.session_revoked === true) {
        yield* setState({ _tag: "RemovedByPhone" });
      } else if (linked?.authenticated && account !== undefined) {
        yield* setLinked(account);
        yield* startConnection;
      } else {
        yield* setState({
          _tag: "Failed",
          reason: "failed",
          message: "Scient couldn't read the saved WhatsApp link. Link again to fix it.",
        });
      }
    }).pipe(Effect.ensuring(Deferred.succeed(ready, undefined))),
  );

  return service;
});

export const layer = Layer.effect(WhatsAppService, make);
