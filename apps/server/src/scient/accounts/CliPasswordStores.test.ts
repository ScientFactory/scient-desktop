// @effect-diagnostics nodeBuiltinImport:off -- Synthetic executables isolate CLI protocol tests from real vaults.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Effect, Redacted } from "effect";
import { expect, it } from "@effect/vitest";
import type { CliPasswordSource, CliPasswordStore } from "@t3tools/contracts";
import { makeHarness, website } from "./Accounts.testkit.ts";
import { makeCliPasswordStores } from "./CliPasswordStores.ts";

async function fixture(mode = "normal", limits: { timeout?: number; maxBuffer?: number } = {}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cli-store-"));
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const out = value => process.stdout.write(JSON.stringify(value));
const bw = path.basename(process.argv[1]) === 'bw';
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'fresh') out({serverUrl:null,lastSync:null,status:'unauthenticated'});
else if (mode === 'overflow') process.stdout.write('x'.repeat(100000));
else if (mode === 'error') { process.stderr.write('SYNTHETIC-PRIVATE'); process.exit(1); }
else if (mode === 'malformed') process.stdout.write('{SYNTHETIC-PRIVATE');
else if (args[0] === 'unlock') {
  if (args.join(' ').includes('SYNTHETIC-MASTER') || args.join(' ') !== 'unlock --passwordenv SCIENT_BW_PASSWORD --raw' || process.env.SCIENT_BW_PASSWORD !== 'SYNTHETIC-MASTER') process.exit(2);
  process.stdout.write('SYNTHETIC-SESSION');
} else if (bw && args[0] === 'status') out({status: mode === 'unauthenticated' ? 'unauthenticated' : process.env.BW_SESSION && !fs.existsSync(path.join(__dirname,'locked')) ? 'unlocked' : 'locked', serverUrl: fs.existsSync(path.join(__dirname,'changed')) ? 'https://other.invalid' : 'https://vault.invalid', userEmail:'synthetic@example.invalid', userId:'user-id'});
else if (bw) {
  if (process.env.SCIENT_BW_PASSWORD || process.env.UNRELATED_SECRET || process.env.BW_SESSION !== 'SYNTHETIC-SESSION') process.exit(3);
  const item = {id:'item-id',name:'Synthetic login',login:{username:'synthetic-user',password:fs.existsSync(path.join(__dirname,'rotated')) ? 'SYNTHETIC-ROTATED' : 'SYNTHETIC-PASSWORD',totp:'SYNTHETIC-SEED'},fields:[{name:'api',value:'SYNTHETIC-CUSTOM'}]};
  if (args[0] === 'list' && args[1] === 'items' && args[2] === '--search' && args[3] === 'Synthetic; $(no-shell)') out([item]);
  else if (args.join(' ') === 'get item item-id') out(item);
  else if (args.join(' ') === 'get totp item-id') process.stdout.write('123456\\n');
  else process.exit(4);
} else if (args.join(' ') === 'info --output json') out({id:'proton-id',email:'synthetic@example.invalid'});
else if (args.join(' ') === 'vault list --output json') out({vaults:[{share_id:'vault-id'}]});
else if (args.join(' ') === 'item list --share-id vault-id --output json') out({items:[{id:'item-id',share_id:'vault-id',title:'Synthetic login'}]});
else if (args[0] === 'item' && args[1] === 'view' && args[3] === '--output' && args[4] === 'json') {
  const field = args[2].split('/').pop();
  const values = {username:'synthetic-user',password:fs.existsSync(path.join(__dirname,'rotated')) ? 'SYNTHETIC-ROTATED' : 'SYNTHETIC-PASSWORD',totp:'123456',api:'SYNTHETIC-CUSTOM'};
  if (!(field in values)) process.exit(5);
  process.stdout.write(values[field]+'\\n');
} else process.exit(6);
`;
  for (const name of ["bw", "pass-cli"])
    await NodeFSP.writeFile(NodePath.join(dir, name), script, { mode: 0o700 });
  const stores = makeCliPasswordStores({
    platform: "darwin",
    commonDirectories: [],
    env: {
      PATH: dir,
      HOME: dir,
      UNRELATED_SECRET: "SYNTHETIC-PRIVATE",
      BW_SESSION: "SYNTHETIC-IGNORED-SESSION",
    },
    ...limits,
  });
  return {
    dir,
    stores,
    async [Symbol.asyncDispose]() {
      stores.dispose();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    },
  };
}
const acquire = (mode = "normal", limits: { timeout?: number; maxBuffer?: number } = {}) =>
  Effect.acquireRelease(
    Effect.promise(() => fixture(mode, limits)),
    (f) => Effect.promise(() => f[Symbol.asyncDispose]()),
  );
const command = (
  stores: ReturnType<typeof makeCliPasswordStores>,
  store: CliPasswordStore,
  action: "connect" | "status" | "disconnect" | "list",
  password?: string,
) =>
  stores.command({
    store,
    action,
    ...(password ? { password } : {}),
    query: "Synthetic; $(no-shell)",
  });
it.effect("detects locked and unauthenticated Bitwarden and Proton status", () =>
  Effect.gen(function* () {
    const locked = yield* acquire();
    expect((yield* command(locked.stores, "bitwarden", "status")).status).toMatchObject({
      state: "locked",
      serverUrl: "https://vault.invalid",
      email: "synthetic@example.invalid",
    });
    const fresh = yield* acquire("fresh");
    expect((yield* command(fresh.stores, "bitwarden", "status")).status).toEqual({
      state: "unauthenticated",
      serverUrl: "https://vault.bitwarden.com",
    });
    const loggedOut = yield* acquire("unauthenticated");
    expect((yield* command(loggedOut.stores, "bitwarden", "status")).status.state).toBe(
      "unauthenticated",
    );
    expect((yield* command(loggedOut.stores, "proton-pass", "status")).status.state).toBe(
      "unlocked",
    );
  }).pipe(Effect.scoped),
);
it.effect(
  "unlocks through child env, projects metadata and resolves fields fresh, refusing disconnect and host changes",
  () =>
    Effect.gen(function* () {
      const f = yield* acquire();
      const connected = yield* command(f.stores, "bitwarden", "connect", "SYNTHETIC-MASTER");
      const source: CliPasswordSource = {
        type: "bitwarden",
        connection: connected.status.connection!,
        itemId: "item-id",
        field: "password",
      };
      const items = yield* command(f.stores, "bitwarden", "list");
      expect(items.items).toEqual([
        {
          itemId: "item-id",
          name: "Synthetic login",
          fields: ["username", "password", "totp", "custom:api"],
        },
      ]);
      expect(JSON.stringify(items)).not.toContain("SYNTHETIC-PASSWORD");
      for (const [field, expected] of [
        ["username", "synthetic-user"],
        ["password", "SYNTHETIC-PASSWORD"],
        ["custom:api", "SYNTHETIC-CUSTOM"],
        ["totp", "123456"],
      ])
        expect(Redacted.value(yield* f.stores.resolve({ ...source, field: field! }))).toBe(
          expected,
        );
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.dir, "rotated"), "true"));
      expect(Redacted.value(yield* f.stores.resolve(source))).toBe("SYNTHETIC-ROTATED");
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.dir, "locked"), "true"));
      expect((yield* Effect.result(f.stores.resolve(source)))._tag).toBe("Failure");
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(f.dir, "locked")));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.dir, "changed"), "true"));
      expect((yield* Effect.result(f.stores.resolve(source)))._tag).toBe("Failure");
      yield* command(f.stores, "bitwarden", "disconnect");
      expect((yield* command(f.stores, "bitwarden", "status")).status.state).toBe("locked");
      expect((yield* Effect.result(f.stores.resolve(source)))._tag).toBe("Failure");
    }).pipe(Effect.scoped),
);
it.effect("searches Proton metadata and resolves pass references with TOTP and custom fields", () =>
  Effect.gen(function* () {
    const f = yield* acquire();
    const connected = yield* command(f.stores, "proton-pass", "connect");
    const list = yield* f.stores.command({ store: "proton-pass", action: "list", query: "login" });
    expect(list.items[0]).toMatchObject({
      itemId: "item-id",
      vaultId: "vault-id",
      name: "Synthetic login",
    });
    expect((yield* command(f.stores, "proton-pass", "list")).items).toEqual([]);
    const source: CliPasswordSource = {
      type: "proton-pass",
      connection: connected.status.connection!,
      itemId: "item-id",
      vaultId: "vault-id",
      field: "password",
    };
    for (const [field, expected] of [
      ["username", "synthetic-user"],
      ["password", "SYNTHETIC-PASSWORD"],
      ["api", "SYNTHETIC-CUSTOM"],
      ["totp", "123456"],
    ])
      expect(Redacted.value(yield* f.stores.resolve({ ...source, field: field! }))).toBe(expected);
    f.stores.dispose();
    expect((yield* Effect.result(f.stores.resolve(source)))._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
it.effect.each(["error", "malformed", "hang", "overflow"])(
  "bounds and sanitizes %s CLI failure",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* acquire(mode, { timeout: 1000, maxBuffer: 1024 });
      expect((yield* command(f.stores, "bitwarden", "status")).status.state).toBe("unavailable");
      const result = yield* Effect.result(
        command(f.stores, "bitwarden", "connect", "SYNTHETIC-MASTER"),
      );
      if (result._tag === "Success") expect(result.success.status.state).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC-PRIVATE");
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC-MASTER");
    }).pipe(Effect.scoped),
);
it.effect("reports missing binaries without invoking another installation", () =>
  Effect.gen(function* () {
    const stores = makeCliPasswordStores({
      platform: "darwin",
      env: { PATH: "" },
      commonDirectories: [],
    });
    for (const store of ["bitwarden", "proton-pass"] as const)
      expect((yield* command(stores, store, "status")).status.state).toBe("not-installed");
    stores.dispose();
  }),
);
it.effect("uses linked CLI values for autofill without copies, caching or OTP regeneration", () =>
  Effect.gen(function* () {
    const f = yield* acquire();
    const { service } = yield* makeHarness({ sourceOverrides: { passwordStores: f.stores } });
    const connected = yield* service.passwordStore({
      store: "bitwarden",
      action: "connect",
      password: "SYNTHETIC-MASTER",
    });
    const source: CliPasswordSource = {
      type: "bitwarden",
      connection: connected.status.connection!,
      itemId: "item-id",
      field: "password",
    };
    const { accountId } = yield* service.save({
      ...website(),
      secrets: { password: source, totp: { ...source, field: "totp" } },
    });
    const first = yield* service.fillValues(accountId, "https://example.com");
    expect(first.password).toBe("SYNTHETIC-PASSWORD");
    expect(first.otp).toBe("123456");
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(f.dir, "rotated"), "true"));
    expect((yield* service.fillValues(accountId, "https://example.com")).password).toBe(
      "SYNTHETIC-ROTATED",
    );
    yield* service.passwordStore({ store: "bitwarden", action: "disconnect" });
    expect((yield* Effect.result(service.fillValues(accountId, "https://example.com")))._tag).toBe(
      "Failure",
    );
    yield* service.save({
      ...website(),
      accountId,
      secrets: {
        password: { type: "scient", value: "SYNTHETIC-REPLACEMENT" },
        totp: { type: "clear" },
      },
    });
    expect((yield* service.snapshot).accounts[0]?.secrets.password?.copies).toEqual([]);
    expect((yield* service.fillValues(accountId, "https://example.com")).password).toBe(
      "SYNTHETIC-REPLACEMENT",
    );
  }).pipe(Effect.scoped),
);
