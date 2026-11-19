// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a local Node server for end-to-end runs.
/**
 * The Worker's request handler on one loopback port, with SQLite and files on disk. Point a
 * development app at it with SCIENT_FEEDBACK_TEST_ENDPOINT=http://127.0.0.1:<port>.
 */
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as ManagedRuntime from "effect/ManagedRuntime";

import { handle } from "../src/Api.ts";
import * as Local from "../src/Local.ts";

const port = Number(process.env.PORT ?? 8790);
const origin = `http://127.0.0.1:${port}`;
const root = NodePath.resolve(import.meta.dirname, "..");
const dataDir = NodePath.resolve(
  process.env.SCIENT_FEEDBACK_DEV_DATA ?? NodePath.join(root, ".scient-feedback-dev"),
);
const adminToken = process.env.SCIENT_FEEDBACK_ADMIN_TOKEN ?? "dev-admin";

const runtime = ManagedRuntime.make(
  Local.layer({
    sql: Local.sqliteFeedbackSql(NodePath.join(dataDir, "feedback.sqlite")),
    files: Local.directoryFiles(NodePath.join(dataDir, "files")),
    settings: { adminToken },
  }),
);

const toRequest = async (incoming: NodeHttp.IncomingMessage) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return new Request(`${origin}${incoming.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
};

const server = NodeHttp.createServer((incoming, outgoing) => {
  void toRequest(incoming)
    .then((request) => runtime.runPromise(handle(request)))
    .then(async (response) => {
      const body = new Uint8Array(await response.arrayBuffer());
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(body);
      console.log(`${incoming.method} ${incoming.url} -> ${response.status}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      outgoing.writeHead(500).end();
    });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Scient feedback (local) on ${origin}`);
  console.log(`  data: ${dataDir}`);
  console.log(
    `  admin token: ${process.env.SCIENT_FEEDBACK_ADMIN_TOKEN ? "(from env)" : "dev-admin"}`,
  );
});
