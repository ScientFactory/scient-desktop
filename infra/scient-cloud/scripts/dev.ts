// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a local Node server for end-to-end runs.
/**
 * The Worker's request handler on one local port with local Durable Object and R2 stand-ins.
 * Test sign-in (`dev:<userId>[:<email>]`) lives only here and in `src/Local.ts`, which the
 * deployed Worker never loads. See README.md.
 */
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { handle } from "../src/Api.ts";
import { clerkPeopleAuth } from "../src/ClerkAuth.ts";
import { cloudError } from "../src/CloudError.ts";
import * as Local from "../src/Local.ts";

const port = Number(process.env.PORT ?? 8787);
const origin = `http://localhost:${port}`;
const root = NodePath.resolve(import.meta.dirname, "..");
const dataDir = NodePath.resolve(
  process.env.SCIENT_CLOUD_DEV_DATA ?? NodePath.join(root, ".scient-cloud-dev"),
);

const devPeople = {
  verify: (token: string) => {
    const match = /^dev:([A-Za-z0-9_-]+)(?::(.+))?$/u.exec(token);
    return match
      ? Effect.succeed({ userId: match[1]! })
      : Effect.fail(cloudError("unauthorized", "Use a test token: dev:<userId>[:<email>]."));
  },
  verifiedEmails: (userId: string) => Effect.succeed(emails.get(userId) ?? []),
};
const emails = new Map<string, Array<string>>();

const clerk =
  process.env.CLERK_SECRET_KEY && process.env.CLERK_JWT_AUDIENCE
    ? clerkPeopleAuth({
        secretKey: process.env.CLERK_SECRET_KEY,
        audience: process.env.CLERK_JWT_AUDIENCE,
      })
    : undefined;

const runtime = ManagedRuntime.make(
  Local.layer({
    dataDir: NodePath.join(dataDir, "sqlite"),
    objects: Local.fileObjects(NodePath.join(dataDir, "objects")),
    peopleAuth: clerk ?? devPeople,
    shareDist: NodePath.join(root, "share", "dist"),
    ...(process.env.SCIENT_CLOUD_KEK ? { kek: process.env.SCIENT_CLOUD_KEK } : {}),
    settings: {
      apiOrigin: origin,
      pageOrigin: origin,
      contentOrigin: origin,
      appOrigins: ["https://app.scientfactory.com", "scient://app", "scient-next-dev://app"],
      allowLocalhostOrigins: true,
    },
  }).pipe(Layer.orDie),
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
  const authorization = headers.get("authorization");
  const devEmail = authorization && /^Bearer dev:([A-Za-z0-9_-]+):(.+)$/u.exec(authorization);
  if (devEmail) emails.set(devEmail[1]!, [devEmail[2]!.toLowerCase()]);
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
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body === null || incoming.method === "HEAD") return outgoing.end();
      NodeStream.Readable.fromWeb(response.body as never).pipe(outgoing);
    })
    .catch((error: unknown) => {
      console.error(error);
      outgoing.writeHead(500).end();
    });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Scient cloud (local) on ${origin}`);
  console.log(`  data: ${dataDir}`);
  console.log(
    `  sign-in: ${clerk ? "Clerk session tokens" : "test tokens dev:<userId>[:<email>]"}`,
  );
});
