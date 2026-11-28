// @effect-diagnostics nodeBuiltinImport:off -- A shell-script stand-in for wacli plays scripted output for the real service.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  ExecutionEnvironmentDescriptor,
  WhatsAppLinkState,
  WhatsAppToolError,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { WacliInstall } from "./WacliInstall.ts";
import { WhatsAppService } from "./WhatsAppService.ts";
import * as WhatsAppServiceLive from "./WhatsAppServiceLive.ts";

const LINKED_DOCTOR = JSON.stringify({
  success: true,
  data: {
    authenticated: true,
    session_revoked: false,
    linked_jid: "972500000001:7@s.whatsapp.net",
  },
  error: null,
});
const event = (name: string, data: Record<string, unknown> = {}, ts = 1_000) =>
  JSON.stringify({ event: name, data, ts });
/** Event times on the test clock, which starts at 0. */
const BAN_AT = 1_000;

interface FakeWacli {
  readonly script: string;
  /** Each call as `<device label>|<arguments>`. */
  readonly calls: () => ReadonlyArray<string>;
  /** Let a held subcommand exit. */
  readonly release: (key: string) => void;
  readonly cleanup: () => void;
}

/**
 * A stand-in wacli. Each subcommand prints `<key>.stderr` and `<key>.stdout` from the scenario
 * directory, stays running while `<key>.hold` exists, and exits with `<key>.exit` (default 0).
 * Every call is logged with the device label it was given.
 */
function makeFakeWacli(files: Record<string, string>): FakeWacli {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-whatsapp-fake-"));
  for (const [name, content] of Object.entries(files)) {
    // wacli ends every line; a held process's last event is only read once its line ends.
    NodeFS.writeFileSync(
      NodePath.join(dir, name),
      name.endsWith(".stderr") ? `${content}\n` : content,
    );
  }
  const script = NodePath.join(dir, "wacli");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh
D='${dir}'
echo "$WACLI_DEVICE_LABEL|$*|$WACLI_STORE_DIR" >> "$D/calls.log"
case "$*" in
  *doctor*) K=doctor;;
  "auth logout"*) K=logout;;
  auth*) K=auth;;
  sync*) K=sync;;
  *"send text"*) K=send;;
  *"chats list"*) K=chats;;
  *"messages list"*) K=messages;;
  *) K=other;;
esac
# A second connection plays sync2.*, what follows a restart.
if [ "$K" = sync ]; then [ -f "$D/sync.ran" ] && K=sync2 || touch "$D/sync.ran"; fi
[ -f "$D/$K.stderr" ] && cat "$D/$K.stderr" >&2
[ -f "$D/$K.stdout" ] && cat "$D/$K.stdout"
while [ -f "$D/$K.hold" ]; do sleep 0.1; done
exit "$(cat "$D/$K.exit" 2>/dev/null || echo 0)"
`,
    { mode: 0o755 },
  );
  return {
    script,
    calls: () => {
      const log = NodePath.join(dir, "calls.log");
      return NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n") : [];
    },
    release: (key: string) => NodeFS.rmSync(NodePath.join(dir, `${key}.hold`), { force: true }),
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

const withService = <A, E>(
  files: Record<string, string>,
  options: { readonly linkedStore?: boolean; readonly longPath?: boolean },
  body: (input: {
    readonly fake: FakeWacli;
    readonly storeDir: string;
  }) => Effect.Effect<A, E, WhatsAppService>,
) =>
  Effect.gen(function* () {
    const fake = yield* Effect.acquireRelease(
      Effect.sync(() => makeFakeWacli(files)),
      (fake) =>
        Effect.sync(() => {
          for (const key of ["auth", "sync", "sync2", "send"]) fake.release(key);
          fake.cleanup();
        }),
    );
    const baseDir = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-wa-test-"))),
      (dir) =>
        Effect.sync(() => {
          // Short links the service made in the temp folder for this test's store.
          for (const name of NodeFS.readdirSync(NodeOS.tmpdir())) {
            const link = NodePath.join(NodeOS.tmpdir(), name);
            if (
              name.startsWith("scient-whatsapp-") &&
              NodeFS.lstatSync(link).isSymbolicLink() &&
              NodeFS.readlinkSync(link).startsWith(dir)
            )
              NodeFS.rmSync(link, { force: true });
          }
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
    );
    // A data folder as deep as a dev worktree's, past the Unix socket path limit.
    const dataDir =
      options.longPath === true ? NodePath.join(baseDir, "a-long-folder-name".repeat(5)) : baseDir;
    const config = ServerConfig.layerTest(dataDir, dataDir).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const stateDir = yield* Effect.map(ServerConfig.ServerConfig, (value) => value.stateDir).pipe(
      Effect.provide(config),
    );
    const storeDir = NodePath.join(stateDir, "whatsapp", "store");
    if (options.linkedStore === true) NodeFS.mkdirSync(storeDir, { recursive: true });
    const layer = WhatsAppServiceLive.layer.pipe(
      Layer.provide(
        Layer.succeed(WacliInstall, { supported: true, executable: Effect.succeed(fake.script) }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            label: "Test MacBook",
          } as unknown as ExecutionEnvironmentDescriptor),
        }),
      ),
      Layer.provide(config),
    );
    return yield* body({ fake, storeDir }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

/** The first status matching `predicate`, from the service's own change stream. */
const statusWhere = (predicate: (state: WhatsAppLinkState) => boolean) =>
  Effect.gen(function* () {
    const service = yield* WhatsAppService;
    const found = yield* service.changes.pipe(
      Stream.filter((status) => predicate(status.state)),
      Stream.runHead,
    );
    return Option.getOrThrow(found);
  });

const toolError = <A>(effect: Effect.Effect<A, WhatsAppToolError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("WhatsAppServiceLive", () => {
  it.effect("shows each new QR code; an unscanned run ends as a failed link", () =>
    withService(
      {
        "auth.stderr": [
          event("auth_starting"),
          event("qr_code", { code: "2@first" }),
          event("qr_code", { code: "2@second" }, 21_000),
        ].join("\n"),
        "auth.hold": "",
      },
      {},
      ({ fake, storeDir }) =>
        Effect.gen(function* () {
          const service = yield* WhatsAppService;
          expect((yield* service.status).state._tag).toBe("Unlinked");
          yield* service.startLink;
          const scanning = yield* statusWhere(
            (state) => state._tag === "AwaitingScan" && state.qr === "2@second",
          );
          expect(scanning.state).toMatchObject({ issuedAt: 21_000 });
          expect(scanning.deviceName).toBe("Test MacBook");
          // wacli gives up without a scan: nothing paired, so nothing is linked.
          fake.release("auth");
          yield* statusWhere((state) => state._tag === "Failed");
          expect(NodeFS.existsSync(storeDir)).toBe(false);
          expect(fake.calls()).toEqual([expect.stringMatching(/^Test MacBook\|auth /u)]);
        }),
    ),
  );

  it.effect("finishes a scanned link, then keeps the connection", () =>
    withService(
      {
        "auth.stderr": [
          event("qr_code", { code: "2@first" }),
          event("connected"),
          event("progress", { messages_synced: 25 }),
          event("idle_exit"),
        ].join("\n"),
        "doctor.stdout": LINKED_DOCTOR,
        "sync.stderr": event("connected", {}, 50_000),
        "sync.hold": "",
      },
      {},
      ({ storeDir }) =>
        Effect.gen(function* () {
          const service = yield* WhatsAppService;
          yield* service.startLink;
          const linked = yield* statusWhere(
            (state) => state._tag === "Linked" && state.connection === "connected",
          );
          expect(linked.state).toEqual({
            _tag: "Linked",
            account: "+972500000001",
            connection: "connected",
            lastActivityAt: 50_000,
          });
          expect((NodeFS.statSync(storeDir).mode & 0o777).toString(8)).toBe("700");
          // A second press while linked changes nothing.
          expect((yield* service.startLink).state._tag).toBe("Linked");
        }),
    ),
  );

  it.effect("reports a passkey request as something Scient can't do yet", () =>
    withService(
      {
        "auth.stderr": event("error", {
          message: "WhatsApp requested passkey verification; passkey pairing is not supported",
        }),
        "auth.exit": "1",
      },
      {},
      ({ storeDir }) =>
        Effect.gen(function* () {
          yield* (yield* WhatsAppService).startLink;
          const failed = yield* statusWhere((state) => state._tag === "Failed");
          expect(failed.state).toMatchObject({ _tag: "Failed", reason: "passkey-required" });
          expect(NodeFS.existsSync(storeDir)).toBe(false);
        }),
    ),
  );

  it.effect("cancelling a link stops it and forgets the partial store", () =>
    withService(
      { "auth.stderr": event("qr_code", { code: "2@first" }), "auth.hold": "" },
      {},
      ({ storeDir }) =>
        Effect.gen(function* () {
          const service = yield* WhatsAppService;
          yield* service.startLink;
          yield* statusWhere((state) => state._tag === "AwaitingScan");
          expect((yield* service.cancelLink).state._tag).toBe("Unlinked");
          expect(NodeFS.existsSync(storeDir)).toBe(false);
        }),
    ),
  );

  it.effect("resumes a saved link at startup; the phone removing it ends the link", () =>
    withService(
      {
        "doctor.stdout": LINKED_DOCTOR,
        "sync.stderr": [event("connected"), event("logged_out")].join("\n"),
      },
      { linkedStore: true },
      () =>
        Effect.gen(function* () {
          yield* statusWhere((state) => state._tag === "RemovedByPhone");
          expect(yield* toolError((yield* WhatsAppService).listChats({ limit: 5 }))).toBe(
            "removed-by-phone",
          );
        }),
    ),
  );

  it.effect("a temporary ban shows when it ends and reconnects only after it", () =>
    withService(
      {
        "doctor.stdout": LINKED_DOCTOR,
        "sync.stderr": event(
          "error",
          { message: "WhatsApp account is temporarily banned: 101 (expires in 1h0m0s)" },
          BAN_AT,
        ),
        "sync.exit": "1",
        "sync2.stderr": event("connected", {}, BAN_AT + 3_700_000),
        "sync2.hold": "",
      },
      { linkedStore: true },
      () =>
        Effect.gen(function* () {
          const service = yield* WhatsAppService;
          const restricted = yield* statusWhere((state) => state._tag === "Restricted");
          expect(restricted.state).toEqual({
            _tag: "Restricted",
            account: "+972500000001",
            until: BAN_AT + 3_600_000,
          });
          expect(yield* toolError(service.sendText({ to: "+972500000002", text: "hi" }))).toBe(
            "restricted",
          );
          // A minute before the end it is still waiting; reconnecting would leave `Restricted`.
          yield* TestClock.adjust(Duration.minutes(59));
          expect((yield* service.status).state._tag).toBe("Restricted");
          yield* TestClock.adjust(Duration.minutes(2));
          yield* statusWhere(
            (state) => state._tag === "Linked" && state.connection === "connected",
          );
        }),
    ),
  );

  it.effect("reads chats and messages and explains WhatsApp's first-message rule", () =>
    withService(
      {
        "doctor.stdout": LINKED_DOCTOR,
        "sync.stderr": event("connected"),
        "sync.hold": "",
        "chats.stdout": JSON.stringify({
          success: true,
          data: [
            {
              jid: "972500000002@s.whatsapp.net",
              kind: "dm",
              name: "Dana",
              last_message_ts: "2026-11-28T17:45:44Z",
              archived: false,
              pinned: true,
              unread: true,
              unread_count: 2,
            },
            { jid: "", kind: "dm", name: "dropped" },
          ],
          error: null,
        }),
        "messages.stdout": JSON.stringify({
          success: true,
          data: {
            fts: true,
            messages: [
              {
                ChatJID: "972500000002@s.whatsapp.net",
                MsgID: "ABC",
                FromMe: false,
                Timestamp: "2026-11-28T17:45:44Z",
                Text: "",
                MediaCaption: "photo caption",
                MediaType: "image",
              },
            ],
            page: { has_more: false },
          },
          error: null,
        }),
        "send.stderr": JSON.stringify({
          success: false,
          data: null,
          error: "send failed: server returned error 463",
        }),
        "send.exit": "1",
      },
      { linkedStore: true },
      () =>
        Effect.gen(function* () {
          const service = yield* WhatsAppService;
          yield* statusWhere(
            (state) => state._tag === "Linked" && state.connection === "connected",
          );
          expect(yield* service.listChats({ limit: 5 })).toEqual([
            {
              jid: "972500000002@s.whatsapp.net",
              name: "Dana",
              kind: "dm",
              lastMessageAt: "2026-11-28T17:45:44.000Z",
              unreadCount: 2,
              archived: false,
              pinned: true,
            },
          ]);
          const [message] = yield* service.listMessages({ chat: "Dana", limit: 5 });
          expect(message).toMatchObject({ id: "ABC", text: "photo caption", mediaType: "image" });
          expect(yield* toolError(service.sendText({ to: "+972500000002", text: "hello" }))).toBe(
            "first-message-from-phone",
          );
          expect(yield* toolError(service.sendText({ to: "+972500000002", text: " " }))).toBe(
            "invalid-input",
          );
        }),
    ),
  );

  it.effect("agents get not-linked before anything is linked", () =>
    withService({}, {}, ({ fake }) =>
      Effect.gen(function* () {
        const service = yield* WhatsAppService;
        expect(yield* toolError(service.searchContacts({ query: "a", limit: 5 }))).toBe(
          "not-linked",
        );
        // Nothing runs without a link.
        expect(fake.calls()).toEqual([]);
      }),
    ),
  );

  it.effect("reaches a store deeper than the socket path limit through a short link", () =>
    withService(
      { "doctor.stdout": LINKED_DOCTOR, "sync.stderr": event("connected"), "sync.hold": "" },
      { linkedStore: true, longPath: true },
      ({ fake, storeDir }) =>
        Effect.gen(function* () {
          expect(NodePath.join(storeDir, ".send.sock").length).toBeGreaterThan(104);
          yield* statusWhere(
            (state) => state._tag === "Linked" && state.connection === "connected",
          );
          const used = new Set(fake.calls().map((call) => call.split("|").at(-1) ?? ""));
          expect(used.size).toBe(1);
          const [link = ""] = used;
          const linkTarget = NodeFS.realpathSync(link);
          expect(NodePath.join(link, ".send.sock").length).toBeLessThanOrEqual(100);
          expect(linkTarget).toBe(NodeFS.realpathSync(storeDir));
        }),
    ),
  );
});
