// @effect-diagnostics nodeBuiltinImport:off -- Runs small stdio programs from a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LocalDuplexProcess from "../../execution/LocalDuplexProcess.ts";
import {
  type LocalConnectorEvent,
  type LocalSignInHandler,
  makeLocalConnectorHost,
} from "./LocalConnectorProcesses.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

/**
 * A site connector: its session is the text of SESSION_FILE when it starts. A call with an old
 * session answers the sign-in marker, as the template's helper does.
 */
const SITE_SERVER = `
import { readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const session = readFileSync(process.env.SESSION_FILE, "utf8");
appendFileSync(process.env.STARTS_FILE, "start\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25",
      capabilities: { tools: {} }, serverInfo: { name: "site", version: "1" } } });
  else if (message.method === "tools/call" && message.params.name === "write") {
    // Something that must not happen twice: recorded at once, answered late or never.
    appendFileSync(process.env.WRITES_FILE, "write\\n");
    if (message.params.arguments?.hang !== true)
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id,
        result: { content: [{ type: "text", text: "written" }] } }), 300);
  } else if (message.method === "tools/call")
    send({ jsonrpc: "2.0", id: message.id, result: session === "fresh"
      ? { content: [{ type: "text", text: "courses: 3" }] }
      : { isError: true, content: [{ type: "text", text: "SCIENT_SIGN_IN_EXPIRED: sent to the sign-in page" }] } });
  else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

const scratch = Effect.promise(async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-local-host-"));
  roots.push(root);
  await NodeFSP.writeFile(NodePath.join(root, "server.mjs"), SITE_SERVER);
  await NodeFSP.writeFile(NodePath.join(root, "session"), "old");
  await NodeFSP.writeFile(NodePath.join(root, "starts"), "");
  await NodeFSP.writeFile(NodePath.join(root, "writes"), "");
  return root;
});

/** A request the agent never cancels. */
const openSignal = () => new AbortController().signal;

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const readEvents = (response: Response) =>
  Effect.promise(async () =>
    (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>),
  );

const textOf = (message: Record<string, unknown> | undefined) =>
  (message?.result as { content: Array<{ text: string }> } | undefined)?.content[0]?.text;

const setup = Effect.fn("setup")(function* (
  signIn: (root: string) => LocalSignInHandler,
  hostOptions: { readonly inFlightGraceMs?: number } = {},
) {
  const root = yield* scratch;
  const events: LocalConnectorEvent[] = [];
  const host = yield* makeLocalConnectorHost({
    onEvent: (event) => Effect.sync(() => void events.push(event)),
    ...hostOptions,
  });
  const identity = { connectorId: "con_site", displayName: "Site" };
  const start = Effect.succeed({
    launch: {
      executable: process.execPath,
      args: [NodePath.join(root, "server.mjs")],
      shell: false,
      cwd: root,
      environment: {
        SESSION_FILE: NodePath.join(root, "session"),
        STARTS_FILE: NodePath.join(root, "starts"),
        WRITES_FILE: NodePath.join(root, "writes"),
      },
    },
    hide: [],
    signInGeneration: 0,
  });
  const handler = signIn(root);
  const post = (sessionId: string | undefined, message: unknown) =>
    host.exchange(
      identity,
      {
        method: "POST",
        sessionId,
        body: encode(message),
        signal: openSignal(),
      },
      start,
      handler,
    );
  const opened = yield* post(undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t" } },
  });
  const sessionId = opened.headers.get("mcp-session-id")!;
  yield* readEvents(opened);
  yield* post(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
  const call = (id: number) =>
    post(sessionId, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "courses", arguments: {} },
    }).pipe(Effect.flatMap(readEvents));
  /** Starts a write and returns its answer still to be read. */
  const startWrite = (id: number, hang = false) =>
    post(sessionId, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "write", arguments: { hang } },
    });
  const writes = Effect.promise(async () =>
    (await NodeFSP.readFile(NodePath.join(root, "writes"), "utf8")).split("\n").filter(Boolean),
  );
  const starts = Effect.promise(async () =>
    (await NodeFSP.readFile(NodePath.join(root, "starts"), "utf8")).split("\n").filter(Boolean),
  );
  return { host, call, startWrite, writes, starts, events };
});

const layer = LocalDuplexProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("signed-in local connectors", () => {
  it.live("sign in again, start a fresh process in the same session and retry the call", () =>
    Effect.gen(function* () {
      let signIns = 0;
      const { call, starts, host } = yield* setup((root) => ({
        expired: () =>
          Effect.promise(async () => {
            signIns += 1;
            await NodeFSP.writeFile(NodePath.join(root, "session"), "fresh");
            return { retry: true } as const;
          }),
        stillExpired: Effect.succeed("still"),
      }));
      const answered = yield* call(2);
      expect(answered).toMatchObject([{ id: 2 }]);
      expect(textOf(answered[0])).toBe("courses: 3");
      expect(signIns).toBe(1);
      // The first process, then its replacement after the new sign-in.
      expect(yield* starts).toEqual(["start", "start"]);
      // The session goes on with the new process.
      expect(textOf((yield* call(3))[0])).toBe("courses: 3");
      expect(yield* starts).toHaveLength(2);
      yield* host.stop("con_site", "done");
    }).pipe(Effect.provide(layer)),
  );

  it.live("says when the site needs the person, and keeps the process", () =>
    Effect.gen(function* () {
      const { call, starts, host } = yield* setup(() => ({
        expired: () =>
          Effect.succeed({ retry: false, message: "site.test needs you to sign in" } as const),
        stillExpired: Effect.succeed("still"),
      }));
      expect(textOf((yield* call(2))[0])).toBe("site.test needs you to sign in");
      expect(yield* starts).toEqual(["start"]);
      yield* host.stop("con_site", "done");
    }).pipe(Effect.provide(layer)),
  );

  it.live("retries once: a call that still finds the session ended gets the explanation", () =>
    Effect.gen(function* () {
      let signIns = 0;
      const { call, host } = yield* setup(() => ({
        expired: () => Effect.sync(() => (signIns += 1)).pipe(Effect.as({ retry: true } as const)),
        stillExpired: Effect.succeed("The site still ended the session."),
      }));
      const answered = yield* call(2);
      expect(textOf(answered[0])).toBe("The site still ended the session.");
      expect(answered[0]).toMatchObject({ result: { isError: true } });
      expect(signIns).toBe(1);
      yield* host.stop("con_site", "done");
    }).pipe(Effect.provide(layer)),
  );

  const freshAfterSignIn = (root: string): LocalSignInHandler => ({
    expired: () =>
      Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(root, "session"), "fresh");
        return { retry: true } as const;
      }),
    stillExpired: Effect.succeed("still"),
  });

  it.live("lets a running call finish on the old process and never sends it again", () =>
    Effect.gen(function* () {
      const { call, startWrite, writes, starts, host } = yield* setup(freshAfterSignIn);
      const writing = yield* startWrite(2);
      // regression: the write was killed and replayed, so it happened twice.
      const answered = yield* call(3);
      expect(textOf(answered[0])).toBe("courses: 3");
      expect(textOf((yield* readEvents(writing))[0])).toBe("written");
      expect(yield* writes).toEqual(["write"]);
      expect(yield* starts).toHaveLength(2);
      yield* host.stop("con_site", "done");
    }).pipe(Effect.provide(layer)),
  );

  it.live(
    "says a call cut off by the new sign-in has an unknown outcome, without replaying it",
    () =>
      Effect.gen(function* () {
        const { call, startWrite, writes, host } = yield* setup(freshAfterSignIn, {
          inFlightGraceMs: 200,
        });
        const writing = yield* startWrite(2, true);
        expect(textOf((yield* call(3))[0])).toBe("courses: 3");
        const [cut] = yield* readEvents(writing);
        expect(cut).toMatchObject({ result: { isError: true } });
        expect(textOf(cut)).toContain("its outcome is unknown");
        expect(yield* writes).toEqual(["write"]);
        yield* host.stop("con_site", "done");
      }).pipe(Effect.provide(layer)),
  );
});

describe("why a local connector stopped", () => {
  it.live("names the error, not Node's version banner after it", () =>
    Effect.gen(function* () {
      const root = yield* scratch;
      const events: LocalConnectorEvent[] = [];
      const host = yield* makeLocalConnectorHost({
        onEvent: (event) => Effect.sync(() => void events.push(event)),
      });
      const start = Effect.succeed({
        launch: {
          executable: process.execPath,
          args: [NodePath.join(root, "missing.mjs")],
          shell: false,
          cwd: root,
          environment: {},
        },
        hide: [],
      });
      const response = yield* host.exchange(
        { connectorId: "con_broken", displayName: "Broken" },
        {
          method: "POST",
          sessionId: undefined,
          body: encode({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t" } },
          }),
          signal: openSignal(),
        },
        start,
      );
      const [answer] = yield* readEvents(response);
      const message = (answer as { error?: { message: string } } | undefined)?.error?.message;
      const failed = events.find((event) => event.type === "failed");
      expect(failed).toMatchObject({ type: "failed" });
      expect((failed as { message: string }).message).toMatch(
        /^Broken could not start: Error: Cannot find module/u,
      );
      expect(message ?? (failed as { message: string }).message).not.toContain("Node.js v");
    }).pipe(Effect.provide(layer)),
  );
});
