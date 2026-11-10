// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalFetchInEffect:off globalJsonInEffect:off globalDate:off globalDateInEffect:off - a CLI check against a running server.
/**
 * End-to-end check over HTTP against `scripts/dev.ts` (test sign-in): enroll two computers,
 * copy a conversation and a file, read both back, continue on the second computer, publish
 * and read a shared link. `node scripts/smoke.ts [http://localhost:8787]`
 */
import * as NodeZlib from "node:zlib";

import {
  LEASE_GENERATION_HEADER,
  THREAD_META_HEADER,
  cloudPaths,
  encodeThreadMetaHeader,
  type ThreadMeta,
} from "@scientfactory/scient-cloud/api";
import {
  computerAuthorizationHeader,
  computerJwsCryptoLayer,
  makeComputerRequestClaims,
  makeEnrollmentProofClaims,
  signComputerRequest,
  signEnrollmentProof,
} from "@scientfactory/scient-cloud/computer-jws";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";

const base = process.argv[2] ?? "http://localhost:8787";
const user = `user_smoke_${Date.now()}`;
const person = { authorization: `Bearer dev:${user}:${user}@example.test` };

const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) process.exitCode = 1;
};

const computer = Effect.fn("Smoke.computer")(function* (env: string) {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const privateKey = yield* Jwk.importPrivate(pair.privateKey, "EdDSA");
  const { kty, crv, x } = pair.publicKey as unknown as Record<string, string>;
  const environmentId = EnvironmentId.make(env);
  const { nonce } = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.computerNonce()}`, { method: "POST", headers: person }).then(
      (response) => response.json() as Promise<{ nonce: string }>,
    ),
  );
  const proof = yield* signEnrollmentProof(
    privateKey,
    yield* makeEnrollmentProofClaims({ environmentId, userId: user, audience: base, nonce }),
  );
  const enrolled = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.computers()}`, {
      method: "POST",
      headers: { ...person, "content-type": "application/json" },
      body: JSON.stringify({ environmentId, label: env, publicKey: { kty, crv, x }, proof }),
    }),
  );
  check(`enroll ${env}`, enrolled.status === 200, yield* Effect.promise(() => enrolled.text()));
  const signed = Effect.fn("Smoke.signed")(function* (
    method: string,
    path: string,
    body: Uint8Array = new Uint8Array(0),
    headers: Record<string, string> = {},
  ) {
    const claims = yield* makeComputerRequestClaims({
      environmentId,
      userId: user,
      audience: base,
      method,
      target: path,
      body,
    });
    const authorization = computerAuthorizationHeader(
      yield* signComputerRequest(privateKey, claims),
    );
    return yield* Effect.promise(() =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization, ...headers },
        ...(method === "GET" || method === "HEAD" ? {} : { body: Uint8Array.from(body) }),
      }),
    );
  });
  return { environmentId, signed };
});

const program = Effect.gen(function* () {
  const a = yield* computer("env-smoke-a");
  const b = yield* computer("env-smoke-b");
  const thread = ThreadId.make("thread-smoke");
  const document = JSON.stringify({ snapshot: { title: "smoke" } });
  const meta: ThreadMeta = {
    title: "Smoke test",
    projectKey: "github.com/example/smoke",
    projectLabel: "smoke",
    updatedAt: new Date().toISOString(),
    archived: false,
    contentDigest: `sha256:${"0".repeat(64)}`,
    generation: 0,
  } as ThreadMeta;

  const file = new TextEncoder().encode("figure");
  const sha = Array.from(
    new Uint8Array(yield* Effect.promise(() => crypto.subtle.digest("SHA-256", file))),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const blobPath = cloudPaths.blob(sha, { env: a.environmentId, thread });
  check("blob absent", (yield* a.signed("HEAD", blobPath)).status === 404);
  check("blob stored", (yield* a.signed("PUT", blobPath, file)).status === 200);

  const put = yield* a.signed(
    "PUT",
    cloudPaths.thread(a.environmentId, thread),
    new Uint8Array(NodeZlib.gzipSync(document)),
    { [THREAD_META_HEADER]: encodeThreadMetaHeader(meta) },
  );
  check("thread stored", put.status === 200, yield* Effect.promise(() => put.text()));

  const read = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.thread(a.environmentId, thread)}`, { headers: person }),
  );
  check(
    "thread read as JSON (fetch decodes gzip)",
    (yield* Effect.promise(() => read.text())) === document,
  );
  const blob = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.blob(sha)}`, { headers: person }).then((response) =>
      response.text(),
    ),
  );
  check("blob read", blob === "figure");

  const lease = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.threadLease(a.environmentId, thread)}`, {
      method: "POST",
      headers: { ...person, "content-type": "application/json" },
      body: JSON.stringify({ to: b.environmentId }),
    }),
  );
  check("lease", lease.headers.get(LEASE_GENERATION_HEADER) === "1");
  const importRead = yield* b.signed("GET", cloudPaths.thread(a.environmentId, thread));
  check(
    "new computer reads the copy",
    (yield* Effect.promise(() => importRead.text())) === document,
  );
  const lost = yield* a.signed(
    "PUT",
    cloudPaths.thread(a.environmentId, thread),
    new Uint8Array(NodeZlib.gzipSync(`${document} `)),
    {
      [THREAD_META_HEADER]: encodeThreadMetaHeader({
        ...meta,
        contentDigest: `sha256:${"1".repeat(64)}`,
      }),
    },
  );
  check("old computer gets lease_lost", lost.status === 409);

  const created = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.shares()}`, {
      method: "POST",
      headers: { ...person, "content-type": "application/json" },
      body: JSON.stringify({
        source: { env: a.environmentId, thread },
        encrypted: true,
        access: { mode: "link" },
        indexable: false,
      }),
    }).then((response) => response.json() as Promise<{ id: string }>),
  );
  yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.shareObject(created.id, 1, "snapshot")}`, {
      method: "PUT",
      headers: person,
      body: new Uint8Array([1, 2, 3]),
    }),
  );
  yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.sharePublish(created.id, 1)}`, { method: "POST", headers: person }),
  );
  const shared = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.publicShareObject(created.id, 1, "snapshot")}`).then(
      async (response) => new Uint8Array(await response.arrayBuffer()),
    ),
  );
  check("shared object read without sign-in", shared.join(",") === "1,2,3");
  const page = yield* Effect.promise(() => fetch(`${base}${cloudPaths.sharePage(created.id)}`));
  check("share page served", page.status === 200);
  const revoked = yield* Effect.promise(() =>
    fetch(`${base}${cloudPaths.share(created.id)}`, { method: "DELETE", headers: person }),
  );
  check("stop sharing", revoked.status === 204);
});

await Effect.runPromise(program.pipe(Effect.provide(computerJwsCryptoLayer)));
