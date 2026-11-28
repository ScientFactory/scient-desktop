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
import * as Hash from "effect/Hash";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { WacliInstall } from "./WacliInstall.ts";
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
  readDoctor,
  readEnvelope,
  readFailure,
  readMessages,
  readSendResult,
  sendFailure,
  sendUncertainError,
  type WacliEnvelope,
} from "./wacliJson.ts";
import {
  runWacli,
  runWacliWithEvents,
  wacliEnvironment,
  type WacliOutput,
} from "./wacliProcess.ts";
import { WhatsAppService } from "./WhatsAppService.ts";

const READ_TIMEOUT = Duration.seconds(30);
/** wacli's own send budget; the process gets a little longer to report it. */
const SEND_TIMEOUT_ARG = "90s";
const SEND_TIMEOUT = Duration.seconds(100);
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4096;
/** Below the 104-byte Unix socket path limit on macOS (108 on Linux). */
const SOCKET_PATH_LIMIT = 100;
/** Restart backoff for the connection: doubled per quick failure, capped. */
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A run that lasted this long resets the backoff. */
const HEALTHY_RUN_MS = 60_000;
/** When WhatsApp restricts the account without saying for how long. */
const UNKNOWN_RESTRICTION_MS = 24 * 60 * 60_000;
const SYNC_ARGS = [
  "sync",
  "--follow",
  "--events",
  "--max-reconnect=0",
  "--stale-threshold=2m",
  "--presence-mode=quiet",
  "--send-spacing=3s-8s",
] as const;
const AUTH_ARGS = ["auth", "--qr-format=text", "--events", "--idle-exit=30s"] as const;

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
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<Services>();

  const whatsappDir = path.join(config.stateDir, "whatsapp");
  const storeDir = path.join(whatsappDir, "store");
  const deviceName = descriptor.label;
  // wacli opens its delegate socket inside the store, and macOS and Linux cap socket paths near
  // 104 bytes. A store whose socket path is too long is reached through a short link in the
  // user's own runtime or temp folder (Windows uses a named pipe instead).
  const socketPathFits =
    (yield* HostProcess.Platform) === "win32" ||
    new TextEncoder().encode(path.join(storeDir, ".send.sock")).length <= SOCKET_PATH_LIMIT;
  const wacliStoreDir = socketPathFits
    ? storeDir
    : path.join(
        hostEnvironment.XDG_RUNTIME_DIR ?? hostEnvironment.TMPDIR ?? "/tmp",
        `scient-whatsapp-${(Hash.string(storeDir) >>> 0).toString(36)}`,
      );
  const env = wacliEnvironment({
    hostEnvironment,
    storeDir: wacliStoreDir,
    deviceLabel: deviceName,
  });
  /** Temp folders get cleaned, so the link is checked before every run. */
  const ensureStoreLink =
    wacliStoreDir === storeDir
      ? Effect.void
      : Effect.gen(function* () {
          const target = yield* fileSystem
            .readLink(wacliStoreDir)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (target === storeDir) return;
          if (target !== undefined) yield* fileSystem.remove(wacliStoreDir);
          yield* fileSystem.symlink(storeDir, wacliStoreDir);
        }).pipe(
          // wacli then reports the socket it cannot open, which the logs show.
          Effect.catchCause((cause) =>
            Effect.logWarning("whatsapp: could not link the store at a short path", { cause }),
          ),
        );

  const state = yield* SubscriptionRef.make<WhatsAppLinkState>({ _tag: "Unlinked" });
  const ready = yield* Deferred.make<void>();
  /** Linking, cancelling and unlinking one at a time. */
  const control = yield* Semaphore.make(1);
  const linkFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const connectionFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);

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

  const connectionLoop = Effect.gen(function* () {
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
      const now = yield* Clock.currentTimeMillis;
      if (result?.removed) {
        yield* setState({ _tag: "RemovedByPhone" });
        return;
      }
      const current = yield* SubscriptionRef.get(state);
      const account = current._tag === "Linked" ? current.account : undefined;
      if (result?.restricted) {
        const until = result.restrictedUntil ?? now + UNKNOWN_RESTRICTION_MS;
        yield* setState({
          _tag: "Restricted",
          ...(account === undefined ? {} : { account }),
          ...(result.restrictedUntil === undefined ? {} : { until: result.restrictedUntil }),
        });
        // Never reconnect before WhatsApp's restriction ends.
        yield* Effect.sleep(Duration.millis(Math.max(0, until - now)));
        const after = yield* SubscriptionRef.get(state);
        yield* setState({
          _tag: "Linked",
          account: (after._tag === "Restricted" ? after.account : undefined) ?? account ?? "+",
          connection: "connecting",
        });
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
          yield* setState({ _tag: "Linked", account, connection: "connecting" });
          yield* startConnection;
          return;
        }
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
      yield* setState({ _tag: "Installing" });
      yield* Ref.set(linkFiber, yield* fork(linkOnce));
      return yield* currentStatus;
    }),
  );

  const cancelLink = control.withPermits(1)(
    Effect.gen(function* () {
      const fiber = yield* Ref.getAndSet(linkFiber, undefined);
      if (fiber === undefined) return yield* currentStatus;
      yield* Fiber.interrupt(fiber);
      yield* removeStore;
      yield* setState({ _tag: "Unlinked" });
      return yield* currentStatus;
    }),
  );

  const unlink = control.withPermits(1)(
    Effect.gen(function* () {
      yield* Deferred.await(ready);
      yield* stopFiber(linkFiber);
      yield* stopFiber(connectionFiber);
      if (yield* storeExists) {
        // Best effort: an offline or already removed device cannot be logged out, only forgotten.
        yield* Effect.gen(function* () {
          yield* runWacli({
            ...(yield* command(["auth", "logout"], "auth logout")),
            timeout: READ_TIMEOUT,
            maxStdoutBytes: MAX_STDOUT_BYTES,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("whatsapp: logout did not complete", { cause }),
          ),
        );
        // Unlinking promises the chats are gone from this computer: say so when they are not.
        yield* fileSystem.remove(storeDir, { recursive: true, force: true }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("whatsapp: could not delete the local store", { cause });
              const message =
                "Scient logged this computer out of WhatsApp but couldn't delete its copy of your chats. Link again or unlink again to retry.";
              yield* setState({ _tag: "Failed", reason: "failed", message });
              return yield* new WhatsAppError({ message });
            }),
          ),
        );
      }
      if (wacliStoreDir !== storeDir) {
        yield* fileSystem.remove(wacliStoreDir, { force: true }).pipe(Effect.ignore);
      }
      yield* setState({ _tag: "Unlinked" });
      return yield* currentStatus;
    }),
  );

  // ── Agent operations ──────────────────────────────────────────────────────

  const requireLink = Effect.gen(function* () {
    yield* Deferred.await(ready);
    const current = yield* SubscriptionRef.get(state);
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
  }, Effect.provideContext(context));

  const optional = (flag: string, value: string | undefined) =>
    value === undefined || value === "" ? [] : [`--${flag}=${value}`];

  const sendFailedToRun = new WhatsAppToolError({
    code: "failed",
    message: "WhatsApp couldn't send the message.",
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
      const link = yield* requireLink;
      if (link.connection !== "connected") return yield* notConnected;
      const output = yield* Effect.flatMap(
        command(
          [
            "--json",
            `--timeout=${SEND_TIMEOUT_ARG}`,
            "send",
            "text",
            `--to=${to}`,
            `--message=${text}`,
            "--no-preview",
            ...optional("reply-to", replyTo),
          ],
          "send text",
        ),
        (cmd) => runWacli({ ...cmd, timeout: SEND_TIMEOUT, maxStdoutBytes: MAX_STDOUT_BYTES }),
      ).pipe(
        Effect.catchTags({
          // A send that ran out of time may already be with WhatsApp.
          WacliProcessError: (error) =>
            error.reason === "timed-out"
              ? Effect.fail(sendUncertainError())
              : Effect.logWarning("whatsapp: send failed to run", { reason: error.reason }).pipe(
                  Effect.andThen(Effect.fail(sendFailedToRun)),
                ),
          WacliInstallError: () => Effect.fail(notConnected),
        }),
      );
      const envelope = envelopeOf(output);
      const sent = envelope?.success === true ? readSendResult(envelope.data) : undefined;
      if (sent !== undefined) return { messageId: sent.id, to: sent.to ?? to };
      // No answer at all from a send that ran may mean it went through.
      if (envelope === undefined) return yield* sendUncertainError();
      return yield* sendFailure(envelope.error ?? "", to);
    }, Effect.provideContext(context)),
  });

  // Startup: an existing store is a link to resume. Nothing runs, and nothing downloads, without one.
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
        yield* setState({ _tag: "Linked", account, connection: "connecting" });
        yield* startConnection;
      } else if (linked !== undefined) {
        // A link that never finished.
        yield* removeStore;
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
