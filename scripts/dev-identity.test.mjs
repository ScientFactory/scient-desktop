import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  cookieDatabasePath,
  captureIdentity,
  DEV_IDENTITY_ENV,
  DEV_IDENTITY_MARKER,
  describeImport,
  ensurePortableVault,
  importDevIdentity,
  makeChromiumCookieDecrypter,
  makePortableVault,
  previewPartitionDirectory,
  reencryptSecret,
  scrubAccountsState,
  seedDevIdentityHome,
  setupHomeCheckout,
  vaultProtection,
} from "./dev-identity.mjs";

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true });
});

const scratch = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dev-identity-"));
  temporaryRoots.push(root);
  return root;
};

const write = (path, data) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, data);
};
const readJson = (path) => JSON.parse(NodeFS.readFileSync(path, "utf8"));

const encrypt = (key, name, value) => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
};
const decrypt = (key, name, blob) => {
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
};

const PROTOCOL_LINE = "export const DEV_IDENTITY_PROTOCOL = 1;\n";
const homeAt = (root) => ({ root, stateDir: NodePath.join(root, "scient-next-dev") });

/** A home whose vault is file-protected, as `seed` leaves it. */
function makeFileVaultHome(root) {
  const home = homeAt(root);
  const secrets = NodePath.join(home.stateDir, "secrets");
  const vault = makePortableVault();
  write(NodePath.join(secrets, "accounts-master-key.bin"), vault.key);
  write(NodePath.join(secrets, "accounts-vault.bin"), vault.sentinel);
  write(
    NodePath.join(secrets, "accounts-state.bin"),
    encrypt(vault.key, "accounts-state", Buffer.from("{}")),
  );
  write(
    NodePath.join(secrets, "custom-model-11111111-1111-4111-8111-111111111111.bin"),
    Buffer.concat([
      Buffer.from([0xff]),
      encrypt(
        vault.key,
        "custom-model-11111111-1111-4111-8111-111111111111",
        Buffer.from("sk-test"),
      ),
    ]),
  );
  write(NodePath.join(secrets, "provider-env-codex-OPENAI_API_KEY.bin"), "plain-value");
  write(NodePath.join(secrets, "server-signing-key.bin"), "home-only");
  write(NodePath.join(secrets, "provider-auth-abc.bin"), "rotating");
  write(
    NodePath.join(home.stateDir, "settings.json"),
    JSON.stringify({
      customModels: [{ id: "m" }],
      providerInstances: { codex: { enabled: true } },
      defaultTheme: "dark",
      projectSettingsOverrides: { "project-1": {} },
    }),
  );
  write(
    NodePath.join(home.stateDir, "scient-extensions.json"),
    JSON.stringify({ formatVersion: 3 }),
  );
  write(NodePath.join(home.stateDir, "connectors", "mine", "connector.json"), "{}");
  write(NodePath.join(home.stateDir, "keybindings.json"), "[]");
  write(
    NodePath.join(home.stateDir, "client-settings.json"),
    JSON.stringify({ browserProfiles: [{ id: "work" }] }),
  );
  write(NodePath.join(home.stateDir, "environment-id"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n");
  return { home, vault };
}

function makeCookieDatabase(path, rows, version = 24) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(path);
  database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  database.exec(
    "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)",
  );
  database.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)");
  for (const row of rows)
    insert.run(row.host, row.name, row.value ?? "", row.encrypted ?? Buffer.alloc(0));
  database.close();
}

const readCookies = (path) => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT name, value, length(encrypted_value) AS sealed FROM cookies ORDER BY name")
      .all();
  } finally {
    database.close();
  }
};

describe("importDevIdentity", () => {
  it("starts on its own when there is no home or the home's key is in the Keychain", async () => {
    const root = scratch();
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    assert.equal(
      (
        await importDevIdentity({
          targetStateDir: target,
          home: homeAt(NodePath.join(root, "none")),
        })
      ).status,
      "no-home",
    );

    const home = homeAt(NodePath.join(root, "home"));
    write(NodePath.join(home.stateDir, "secrets", "accounts-vault.bin"), Buffer.from([1, 2, 3]));
    write(NodePath.join(target, "secrets", "accounts-state.bin"), "candidate-own");
    const result = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(result.status, "home-vault-not-portable");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(target, "secrets", "accounts-state.bin"), "utf8"),
      "candidate-own",
    );
    assert.match(describeImport(result), /pnpm dev:identity seed/u);
    assert.equal(
      (
        await importDevIdentity({
          targetStateDir: target,
          home,
          environment: { [DEV_IDENTITY_ENV]: "off" },
        })
      ).status,
      "disabled",
    );
  });

  it("copies the identity families as sets and leaves the install's own secrets", async () => {
    const root = scratch();
    const { home, vault } = makeFileVaultHome(NodePath.join(root, "home"));
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const secrets = NodePath.join(target, "secrets");
    // A candidate that once made its own Keychain vault and model key.
    write(NodePath.join(secrets, "accounts-vault.bin"), Buffer.from([1, 9, 9]));
    write(
      NodePath.join(secrets, "accounts-value-22222222-2222-4222-8222-222222222222.bin"),
      "stale",
    );
    write(NodePath.join(secrets, "custom-model-old.bin"), "stale");
    write(NodePath.join(secrets, "server-signing-key.bin"), "candidate-own");

    const result = await importDevIdentity({ targetStateDir: target, home });

    assert.equal(result.status, "imported");
    assert.deepEqual(NodeFS.readdirSync(secrets).sort(), [
      "accounts-master-key.bin",
      "accounts-state.bin",
      "accounts-vault.bin",
      "custom-model-11111111-1111-4111-8111-111111111111.bin",
      "provider-env-codex-OPENAI_API_KEY.bin",
      "server-signing-key.bin",
    ]);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(secrets, "server-signing-key.bin"), "utf8"),
      "candidate-own",
    );
    assert.equal(vaultProtection(target), "file");
    const copiedKey = NodeFS.readFileSync(NodePath.join(secrets, "accounts-master-key.bin"));
    assert.deepEqual(copiedKey, vault.key);
    assert.equal(
      decrypt(
        copiedKey,
        "accounts-state",
        NodeFS.readFileSync(NodePath.join(secrets, "accounts-state.bin")),
      ).toString(),
      "{}",
    );
    assert.equal(
      NodeFS.statSync(NodePath.join(secrets, "accounts-master-key.bin")).mode & 0o777,
      0o600,
    );
  });

  it("brings the whole profile on the first start and only the identity afterwards", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const target = NodePath.join(root, "candidate", "scient-next-dev");

    const first = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(first.firstStart, true);
    assert.deepEqual(readJson(NodePath.join(target, "settings.json")), {
      customModels: [{ id: "m" }],
      providerInstances: { codex: { enabled: true } },
      defaultTheme: "dark",
    });
    assert.ok(NodeFS.existsSync(NodePath.join(target, "keybindings.json")));
    assert.ok(NodeFS.existsSync(NodePath.join(target, "connectors", "mine", "connector.json")));
    assert.deepEqual(readJson(NodePath.join(target, "client-settings.json")), {
      browserProfiles: [{ id: "work" }],
    });
    assert.equal(readJson(NodePath.join(target, DEV_IDENTITY_MARKER)).status, "imported");

    // The dev app changes its theme and the home changes a model; the next start keeps the theme.
    write(
      NodePath.join(target, "settings.json"),
      JSON.stringify({
        ...readJson(NodePath.join(target, "settings.json")),
        defaultTheme: "light",
        threadSections: ["x"],
      }),
    );
    write(
      NodePath.join(home.stateDir, "settings.json"),
      JSON.stringify({ customModels: [{ id: "n" }], defaultTheme: "dark" }),
    );
    NodeFS.rmSync(NodePath.join(home.stateDir, "connectors"), { recursive: true });

    const second = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(second.firstStart, false);
    assert.deepEqual(readJson(NodePath.join(target, "settings.json")), {
      customModels: [{ id: "n" }],
      defaultTheme: "light",
      threadSections: ["x"],
    });
    assert.equal(NodeFS.existsSync(NodePath.join(target, "connectors")), false);
  });

  it("never imports into the home itself, even through the checkout's symlink", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "scient-desktop-identity");
    NodeFS.mkdirSync(checkout);
    NodeFS.symlinkSync(home.root, NodePath.join(checkout, ".scient-next"));
    const result = await importDevIdentity({
      targetStateDir: NodePath.join(checkout, ".scient-next", "scient-next-dev"),
      home,
    });
    assert.equal(result.status, "home");
  });

  it("places website sign-ins in the profiles a new dev app will open, once", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const homeEnvironment = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const partitions = NodePath.join(home.stateDir, "electron-userdata", "Partitions");
    makeCookieDatabase(
      NodePath.join(partitions, previewPartitionDirectory(homeEnvironment), "Cookies"),
      [{ host: ".example.org", name: "session", value: "default-profile" }],
    );
    makeCookieDatabase(
      NodePath.join(partitions, previewPartitionDirectory(homeEnvironment, "work"), "Cookies"),
      [{ host: ".example.org", name: "session", value: "work-profile" }],
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");

    const result = await importDevIdentity({ targetStateDir: target, home });
    const environmentId = NodeFS.readFileSync(
      NodePath.join(target, "environment-id"),
      "utf8",
    ).trim();
    assert.match(environmentId, /^[0-9a-f-]{36}$/u);
    assert.notEqual(environmentId, homeEnvironment);
    assert.equal(result.websiteProfiles, 2);
    const targetPartitions = NodePath.join(target, "electron-userdata", "Partitions");
    assert.deepEqual(
      readCookies(
        NodePath.join(targetPartitions, previewPartitionDirectory(environmentId), "Cookies"),
      ),
      [{ name: "session", value: "default-profile", sealed: 0 }],
    );
    assert.deepEqual(
      readCookies(
        NodePath.join(
          targetPartitions,
          previewPartitionDirectory(environmentId, "work"),
          "Cookies",
        ),
      ),
      [{ name: "session", value: "work-profile", sealed: 0 }],
    );

    // Sign-ins made inside the dev app are not replaced on the next start.
    NodeFS.rmSync(NodePath.join(partitions, previewPartitionDirectory(homeEnvironment)), {
      recursive: true,
    });
    makeCookieDatabase(
      NodePath.join(partitions, previewPartitionDirectory(homeEnvironment), "Cookies"),
      [{ host: ".example.org", name: "session", value: "changed-at-home" }],
    );
    const again = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(again.websiteProfiles, 0);
    assert.deepEqual(
      readCookies(
        NodePath.join(targetPartitions, previewPartitionDirectory(environmentId), "Cookies"),
      ),
      [{ name: "session", value: "default-profile", sealed: 0 }],
    );
  });
});

describe("previewPartitionDirectory", () => {
  it("keeps the default profile's bare environment id and namespaces named profiles", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const digest = (scope) =>
      NodeCrypto.createHash("sha256").update(scope).digest("hex").slice(0, 20);
    assert.equal(previewPartitionDirectory(id), `scient-next-preview-${digest(id)}`);
    assert.equal(previewPartitionDirectory(id, "default"), `scient-next-preview-${digest(id)}`);
    assert.equal(
      previewPartitionDirectory(id, "work"),
      `scient-next-preview-profile-${digest(JSON.stringify([id, "work"]))}`,
    );
  });
});

describe("seedDevIdentityHome", () => {
  function makeInstalledApp(root) {
    const stateDir = NodePath.join(root, "userdata");
    const userData = NodePath.join(root, "Application Support", "scient-next");
    const key = NodeCrypto.randomBytes(32);
    const secrets = NodePath.join(stateDir, "secrets");
    write(
      NodePath.join(secrets, "accounts-vault.bin"),
      Buffer.concat([Buffer.from([1]), encrypt(key, "accounts-vault", Buffer.alloc(0))]),
    );
    write(
      NodePath.join(secrets, "accounts-state.bin"),
      encrypt(key, "accounts-state", Buffer.from('{"accounts":[]}')),
    );
    const valueName = "accounts-value-33333333-3333-4333-8333-333333333333";
    write(
      NodePath.join(secrets, `${valueName}.bin`),
      encrypt(key, valueName, Buffer.from("password")),
    );
    write(
      NodePath.join(secrets, "custom-model-44444444-4444-4444-8444-444444444444.bin"),
      Buffer.concat([
        Buffer.from([0xff]),
        encrypt(key, "custom-model-44444444-4444-4444-8444-444444444444", Buffer.from("sk-live")),
      ]),
    );
    write(NodePath.join(secrets, "overleaf-git-token-b3ZlcmxlYWYuY29t.bin"), "olp_token");
    write(NodePath.join(secrets, "server-signing-key.bin"), "production-only");
    write(
      NodePath.join(stateDir, "settings.json"),
      JSON.stringify({ customModels: [{ id: "m" }], threadSections: ["t"] }),
    );
    write(NodePath.join(stateDir, "client-settings.json"), JSON.stringify({ language: "en" }));
    write(NodePath.join(stateDir, "environment-id"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\n");
    const cookieSecret = "cookie-secret";
    const cookieKey = NodeCrypto.pbkdf2Sync(cookieSecret, "saltysalt", 1003, 16, "sha1");
    const sealCookie = (host, value) => {
      const cipher = NodeCrypto.createCipheriv("aes-128-cbc", cookieKey, Buffer.alloc(16, 0x20));
      const plain = Buffer.concat([
        NodeCrypto.createHash("sha256").update(host).digest(),
        Buffer.from(value),
      ]);
      return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
    };
    makeCookieDatabase(
      NodePath.join(
        userData,
        "Partitions",
        previewPartitionDirectory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        "Cookies",
      ),
      [
        {
          host: ".journal.org",
          name: "a-session",
          encrypted: sealCookie(".journal.org", "signed-in"),
        },
        { host: ".plain.org", name: "b-plain", value: "kept" },
        { host: ".broken.org", name: "c-broken", encrypted: Buffer.from("v10garbage") },
      ],
    );
    const installed = {
      stateDir,
      userData,
      vaultKeychainAccount: "vault-account",
      cookieKeychains: [
        { service: "Scient Safe Storage", account: "Scient" },
        { service: "scient-next Safe Storage", account: "scient-next Key" },
      ],
    };
    const readKeychain = async (service, account) =>
      service === "Scient Accounts" && account === "vault-account"
        ? key.toString("base64")
        : service === "scient-next Safe Storage" && account === "scient-next Key"
          ? cookieSecret
          : null;
    return { installed, readKeychain, key };
  }

  const fingerprint = (root) => {
    const hash = NodeCrypto.createHash("sha256");
    const walk = (dir) => {
      for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = NodePath.join(dir, entry.name);
        hash.update(path);
        if (entry.isDirectory()) walk(path);
        else hash.update(NodeFS.readFileSync(path));
      }
    };
    walk(root);
    return hash.digest("hex");
  };

  it("re-encrypts the installed app's accounts under a portable key and never writes to it", async () => {
    const root = scratch();
    const { installed, readKeychain } = makeInstalledApp(NodePath.join(root, "installed"));
    const before = fingerprint(NodePath.join(root, "installed"));
    const home = homeAt(NodePath.join(root, "home"));

    const report = await seedDevIdentityHome({
      home,
      installed,
      readKeychain,
      isRunning: () => false,
    });

    assert.equal(fingerprint(NodePath.join(root, "installed")), before);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.secrets, 4);
    assert.equal(vaultProtection(home.stateDir), "file");
    const secrets = NodePath.join(home.stateDir, "secrets");
    const key = NodeFS.readFileSync(NodePath.join(secrets, "accounts-master-key.bin"));
    assert.equal(
      decrypt(
        key,
        "accounts-vault",
        NodeFS.readFileSync(NodePath.join(secrets, "accounts-vault.bin")).subarray(1),
      ).length,
      0,
    );
    assert.equal(
      decrypt(
        key,
        "accounts-state",
        NodeFS.readFileSync(NodePath.join(secrets, "accounts-state.bin")),
      ).toString(),
      '{"accounts":[]}',
    );
    const valueName = "accounts-value-33333333-3333-4333-8333-333333333333";
    assert.equal(
      decrypt(
        key,
        valueName,
        NodeFS.readFileSync(NodePath.join(secrets, `${valueName}.bin`)),
      ).toString(),
      "password",
    );
    const sealed = NodeFS.readFileSync(
      NodePath.join(secrets, "custom-model-44444444-4444-4444-8444-444444444444.bin"),
    );
    assert.equal(sealed[0], 0xff);
    assert.equal(
      decrypt(
        key,
        "custom-model-44444444-4444-4444-8444-444444444444",
        sealed.subarray(1),
      ).toString(),
      "sk-live",
    );
    assert.equal(
      NodeFS.readFileSync(
        NodePath.join(secrets, "overleaf-git-token-b3ZlcmxlYWYuY29t.bin"),
        "utf8",
      ),
      "olp_token",
    );
    assert.equal(NodeFS.existsSync(NodePath.join(secrets, "server-signing-key.bin")), false);
    assert.deepEqual(readJson(NodePath.join(home.stateDir, "settings.json")), {
      customModels: [{ id: "m" }],
    });
    assert.deepEqual(readJson(NodePath.join(home.stateDir, "client-settings.json")), {
      language: "en",
    });

    const homeEnvironment = NodeFS.readFileSync(
      NodePath.join(home.stateDir, "environment-id"),
      "utf8",
    ).trim();
    assert.equal(report.websiteProfiles, 1);
    assert.deepEqual(
      readCookies(
        NodePath.join(
          home.stateDir,
          "electron-userdata",
          "Partitions",
          previewPartitionDirectory(homeEnvironment),
          "Cookies",
        ),
      ),
      [
        { name: "a-session", value: "signed-in", sealed: 0 },
        { name: "b-plain", value: "kept", sealed: 0 },
      ],
    );

    // A dev app then gets the seeded accounts without any Keychain access.
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    assert.equal((await importDevIdentity({ targetStateDir: target, home })).status, "imported");
    assert.equal(vaultProtection(target), "file");
  });

  it("refuses while the home app runs, and a second seed without --force", async () => {
    const root = scratch();
    const { installed, readKeychain } = makeInstalledApp(NodePath.join(root, "installed"));
    const home = homeAt(NodePath.join(root, "home"));
    let error = await seedDevIdentityHome({
      home,
      installed,
      readKeychain,
      isRunning: () => true,
    }).catch((cause) => cause);
    assert.match(String(error), /Quit Scient \(Dev\)/u);
    await seedDevIdentityHome({ home, installed, readKeychain, isRunning: () => false });
    error = await seedDevIdentityHome({
      home,
      installed,
      readKeychain,
      isRunning: () => false,
    }).catch((cause) => cause);
    assert.match(String(error), /--force/u);
    await seedDevIdentityHome({
      home,
      installed,
      readKeychain,
      isRunning: () => false,
      force: true,
    });
  });
});

describe("what a copy must not carry over", () => {
  it("drops the source install's senders and choices from Accounts", async () => {
    const root = scratch();
    const { home, vault } = makeFileVaultHome(NodePath.join(root, "home"));
    const valueName = "accounts-value-55555555-5555-4555-8555-555555555555";
    write(
      NodePath.join(home.stateDir, "secrets", "accounts-state.bin"),
      encrypt(
        vault.key,
        "accounts-state",
        Buffer.from(
          JSON.stringify({
            format: 1,
            accounts: [
              { summary: { id: "a" }, values: { password: valueName }, pendingCopies: { x: [] } },
            ],
            senders: [{ source: "env" }],
            senderKeys: [{ environmentId: "env", key: "k" }],
            profileChoices: { thread: "p" },
          }),
        ),
      ),
    );
    write(
      NodePath.join(home.stateDir, "secrets", `${valueName}.bin`),
      encrypt(vault.key, valueName, Buffer.from("pw")),
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    await importDevIdentity({ targetStateDir: target, home });
    const state = JSON.parse(
      decrypt(
        vault.key,
        "accounts-state",
        NodeFS.readFileSync(NodePath.join(target, "secrets", "accounts-state.bin")),
      ).toString(),
    );
    assert.deepEqual(state, {
      format: 1,
      accounts: [{ summary: { id: "a" }, values: { password: valueName } }],
    });
  });

  it("rebases connector folders and never lets a copy own a folder outside its state", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "scient-desktop-identity");
    write(NodePath.join(home.root, "dev-identity-home.json"), JSON.stringify({ checkout }));
    const homeServerDir = NodePath.join(checkout, ".scient-next", "scient-next-dev");
    write(
      NodePath.join(home.stateDir, "scient-extensions.json"),
      JSON.stringify({
        connectors: [
          { local: { directory: `${homeServerDir}/connectors/mine`, owned: true } },
          { local: { directory: `${home.stateDir}/connectors/other`, owned: true } },
          { local: { directory: "/Users/someone/code/connector", owned: true } },
          { local: { directory: "/Users/someone/code/shared", owned: false } },
        ],
      }),
    );
    write(
      NodePath.join(home.stateDir, "settings.json"),
      JSON.stringify({
        providerInstances: { codex: { config: { home: `${homeServerDir}/providers/codex` } } },
      }),
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    await importDevIdentity({ targetStateDir: target, home });
    assert.deepEqual(readJson(NodePath.join(target, "scient-extensions.json")).connectors, [
      { local: { directory: `${target}/connectors/mine`, owned: true } },
      { local: { directory: `${target}/connectors/other`, owned: true } },
      { local: { directory: "/Users/someone/code/connector", owned: false } },
      { local: { directory: "/Users/someone/code/shared", owned: false } },
    ]);
    assert.equal(
      readJson(NodePath.join(target, "settings.json")).providerInstances.codex.config.home,
      `${target}/providers/codex`,
    );
  });

  it("removes records sealed under the candidate's old key and copies Cursor's sign-in", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const cursorSlot = `provider-auth-${NodeCrypto.createHash("sha256").update("6:cursorcursor").digest("hex")}.bin`;
    write(NodePath.join(home.stateDir, "secrets", cursorSlot), "cursor-key");
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const secrets = NodePath.join(target, "secrets");
    write(NodePath.join(secrets, "accounts-master-key.bin"), NodeCrypto.randomBytes(32));
    write(
      NodePath.join(secrets, "secret-request-00000000000000000000000000000000.bin"),
      Buffer.from([0xff, 1, 2]),
    );
    write(NodePath.join(secrets, "secret-request-salt.bin"), "plain-salt");
    await importDevIdentity({ targetStateDir: target, home });
    const names = NodeFS.readdirSync(secrets);
    assert.include(names, cursorSlot);
    assert.include(names, "secret-request-salt.bin");
    assert.notInclude(names, "secret-request-00000000000000000000000000000000.bin");
    assert.notInclude(names, "provider-auth-abc.bin");
  });

  it("refuses a home whose settings point at a record that has not landed", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const ref = "custom-model-66666666-6666-4666-8666-666666666666";
    write(
      NodePath.join(home.stateDir, "settings.json"),
      JSON.stringify({ customModels: [{ keyRef: ref }] }),
    );
    assert.equal(captureIdentity(home.stateDir, { attempts: 2 }), undefined);
    write(
      NodePath.join(home.stateDir, "settings.json"),
      JSON.stringify({
        providerInstances: {
          codex: {
            driver: "codex",
            environment: [{ name: "OPENAI_API_KEY", valueRedacted: true }],
          },
        },
      }),
    );
    assert.equal(captureIdentity(home.stateDir, { attempts: 2 }), undefined);
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "secrets", "accounts-state.bin"), "kept");
    const result = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(result.status, "home-busy");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(target, "secrets", "accounts-state.bin"), "utf8"),
      "kept",
    );
  });

  it("reads again when the home saves in the middle of a copy", () => {
    const root = scratch();
    const { home, vault } = makeFileVaultHome(NodePath.join(root, "home"));
    const statePath = NodePath.join(home.stateDir, "secrets", "accounts-state.bin");
    const reads = [];
    const capture = captureIdentity(home.stateDir, {
      afterRead: (attempt) => {
        reads.push(attempt);
        if (attempt === 0)
          write(statePath, encrypt(vault.key, "accounts-state", Buffer.from('{"saved":2}')));
      },
    });
    assert.deepEqual(reads, [0, 1]);
    assert.deepEqual(capture.accounts, { saved: 2 });
  });

  it("merges browser profiles a dev app lacks without changing its own default", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    write(
      NodePath.join(home.stateDir, "client-settings.json"),
      JSON.stringify({
        browserProfiles: [{ id: "work" }, { id: "lab" }],
        browserDefaultProfileId: "lab",
      }),
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "settings.json"), "{}");
    write(
      NodePath.join(target, "client-settings.json"),
      JSON.stringify({
        browserProfiles: [{ id: "work", name: "mine" }],
        browserDefaultProfileId: "gone",
        language: "he",
      }),
    );
    await importDevIdentity({ targetStateDir: target, home });
    assert.deepEqual(readJson(NodePath.join(target, "client-settings.json")), {
      browserProfiles: [{ id: "work", name: "mine" }, { id: "lab" }],
      browserDefaultProfileId: "lab",
      language: "he",
    });
  });

  it("gives a new home a file key, so its first launch never makes a Keychain one", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "scient-desktop-identity");
    write(NodePath.join(checkout, "scripts", "dev-identity.mjs"), PROTOCOL_LINE);
    setupHomeCheckout({ repoRoot: root, checkout, home, run: () => {} });
    assert.equal(vaultProtection(home.stateDir), "file");
    assert.equal(ensurePortableVault(home.stateDir), false);
    assert.deepEqual(readJson(NodePath.join(home.root, "dev-identity-home.json")), { checkout });
  });
});

describe("reencryptSecret and cookies", () => {
  it("does not carry the source vault's own key or sentinel", () => {
    const a = NodeCrypto.randomBytes(32);
    const b = NodeCrypto.randomBytes(32);
    assert.equal(reencryptSecret("accounts-vault.bin", Buffer.from([1]), a, b), undefined);
    assert.equal(reencryptSecret("accounts-master-key.bin", a, a, b), undefined);
    assert.equal(
      reencryptSecret("provider-env-x.bin", Buffer.from("plain"), a, b).toString(),
      "plain",
    );
  });

  it("reads Chromium v10 cookies with and without the host hash", () => {
    const key = NodeCrypto.pbkdf2Sync("s", "saltysalt", 1003, 16, "sha1");
    const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const sealed = Buffer.concat([
      Buffer.from("v10"),
      cipher.update(Buffer.from("value")),
      cipher.final(),
    ]);
    const read = makeChromiumCookieDecrypter("s");
    assert.equal(read(sealed, { hashPrefix: false }), "value");
    assert.equal(read(Buffer.from("v11xx"), { hashPrefix: false }), undefined);
    const hashed = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const withHost = Buffer.concat([
      Buffer.from("v10"),
      hashed.update(
        Buffer.concat([
          NodeCrypto.createHash("sha256").update(".a.org").digest(),
          Buffer.from("v"),
        ]),
      ),
      hashed.final(),
    ]);
    assert.equal(read(withHost, { hostKey: ".a.org", hashPrefix: true }), "v");
    // A value bound to another host is not moved onto this one.
    assert.equal(read(withHost, { hostKey: ".b.org", hashPrefix: true }), undefined);
  });
});

describe("setupHomeCheckout", () => {
  it("points the checkout's app data at the home and refuses a checkout holding its own", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "scient-desktop-identity");
    write(NodePath.join(checkout, "scripts", "dev-identity.mjs"), PROTOCOL_LINE);
    const calls = [];
    setupHomeCheckout({ repoRoot: root, checkout, home, run: (...args) => calls.push(args) });
    assert.deepEqual(calls, []);
    assert.equal(
      NodeFS.realpathSync(NodePath.join(checkout, ".scient-next")),
      NodeFS.realpathSync(home.root),
    );

    const other = NodePath.join(root, "other", "scient-desktop-identity");
    NodeFS.mkdirSync(NodePath.join(other, ".scient-next"), { recursive: true });
    assert.throws(
      () => setupHomeCheckout({ repoRoot: root, checkout: other, home }),
      /already holds/u,
    );
    assert.throws(
      () => setupHomeCheckout({ repoRoot: root, checkout: NodePath.join(root, "x"), home }),
      /scient-desktop-identity/u,
    );
  });
});

describe("code review guards", () => {
  it("re-encrypts connector sign-ins on seed and keeps legacy JSON ones readable", async () => {
    const root = scratch();
    const installedRoot = NodePath.join(root, "installed");
    const stateDir = NodePath.join(installedRoot, "userdata");
    const key = NodeCrypto.randomBytes(32);
    const secrets = NodePath.join(stateDir, "secrets");
    write(
      NodePath.join(secrets, "accounts-vault.bin"),
      Buffer.concat([Buffer.from([1]), encrypt(key, "accounts-vault", Buffer.alloc(0))]),
    );
    const current = "connector-77777777-7777-4777-8777-777777777777";
    const legacy = "connector-88888888-8888-4888-8888-888888888888";
    write(
      NodePath.join(secrets, `${current}.bin`),
      encrypt(key, current, Buffer.from('{"token":"t"}')),
    );
    write(NodePath.join(secrets, `${legacy}.bin`), '{"token":"old"}');
    write(
      NodePath.join(stateDir, "scient-extensions.json"),
      JSON.stringify({ refs: [current, legacy] }),
    );
    const home = homeAt(NodePath.join(root, "home"));
    await seedDevIdentityHome({
      home,
      installed: {
        stateDir,
        userData: NodePath.join(installedRoot, "none"),
        vaultKeychainAccount: "a",
        cookieKeychains: [],
      },
      readKeychain: async (service) =>
        service === "Scient Accounts" ? key.toString("base64") : null,
      isRunning: () => false,
    });
    const homeKey = NodeFS.readFileSync(
      NodePath.join(home.stateDir, "secrets", "accounts-master-key.bin"),
    );
    assert.equal(
      decrypt(
        homeKey,
        current,
        NodeFS.readFileSync(NodePath.join(home.stateDir, "secrets", `${current}.bin`)),
      ).toString(),
      '{"token":"t"}',
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(home.stateDir, "secrets", `${legacy}.bin`), "utf8"),
      '{"token":"old"}',
    );
  });

  it("leaves the home untouched when the Keychain refuses the installed app's key", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const before = NodeFS.readdirSync(NodePath.join(home.stateDir, "secrets")).sort();
    const stateDir = NodePath.join(root, "installed", "userdata");
    write(NodePath.join(stateDir, "secrets", "accounts-vault.bin"), Buffer.from([1, 0]));
    const error = await seedDevIdentityHome({
      home,
      installed: { stateDir, userData: root, vaultKeychainAccount: "a", cookieKeychains: [] },
      readKeychain: async () => null,
      isRunning: () => false,
    }).catch((cause) => cause);
    assert.match(String(error), /nothing was copied/u);
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(home.stateDir, "secrets")).sort(), before);
    assert.equal(NodeFS.existsSync(NodePath.join(home.root, "dev-identity-seed.lock")), false);
  });

  it("holds a lock through the seed that keeps the home app from starting", async () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const stateDir = NodePath.join(root, "installed", "userdata");
    write(NodePath.join(stateDir, "secrets", "accounts-vault.bin"), Buffer.from([1, 0]));
    let seenDuringSeed;
    await seedDevIdentityHome({
      home,
      installed: { stateDir, userData: root, vaultKeychainAccount: "a", cookieKeychains: [] },
      readKeychain: async () => {
        seenDuringSeed = await importDevIdentity({
          targetStateDir: home.stateDir,
          home,
        });
        return null;
      },
      isRunning: () => false,
    }).catch(() => {});
    assert.deepEqual(seenDuringSeed, { status: "home-seeding" });
  });

  it("never writes into a data folder linked to the home or the installed app", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const candidate = NodePath.join(root, "candidate");
    NodeFS.mkdirSync(candidate);
    const linked = NodePath.join(candidate, "scient-next-dev");
    NodeFS.symlinkSync(home.stateDir, linked);
    const before = NodeFS.readdirSync(NodePath.join(home.stateDir, "secrets")).sort();
    assert.equal(
      (await importDevIdentity({ targetStateDir: linked, home })).status,
      "refused-target",
    );
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(home.stateDir, "secrets")).sort(), before);

    const installedState = NodePath.join(root, "installed", "userdata");
    NodeFS.mkdirSync(installedState, { recursive: true });
    const other = NodePath.join(root, "other");
    NodeFS.mkdirSync(other);
    NodeFS.symlinkSync(installedState, NodePath.join(other, "scient-next-dev"));
    const result = await importDevIdentity({
      targetStateDir: NodePath.join(other, "scient-next-dev"),
      home,
      installed: { stateDir: installedState },
    });
    assert.equal(result.status, "refused-target");
    assert.deepEqual(NodeFS.readdirSync(installedState), []);
  });

  it("changes nothing in a dev app when a replacement cannot be written", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "secrets", "accounts-state.bin"), "old");
    write(NodePath.join(target, "settings.json"), "{}");
    // The connectors folder cannot be staged, after the secrets were staged.
    NodeFS.chmodSync(target, 0o500);
    let result;
    try {
      result = await importDevIdentity({ targetStateDir: target, home });
    } finally {
      NodeFS.chmodSync(target, 0o700);
    }
    assert.equal(result.status, "copy-failed");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(target, "secrets", "accounts-state.bin"), "utf8"),
      "old",
    );
    assert.deepEqual(
      NodeFS.readdirSync(NodePath.join(target, "secrets")).filter((name) =>
        name.includes("staged"),
      ),
      [],
    );
    assert.equal(NodeFS.existsSync(NodePath.join(target, "dev-identity-journal.json")), false);
  });

  it("finishes a copy that stopped while publishing, before the app opens its vault", async () => {
    const root = scratch();
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const secrets = NodePath.join(target, "secrets");
    write(NodePath.join(secrets, "accounts-master-key.bin"), "old-key");
    write(NodePath.join(secrets, "accounts-master-key.bin.dev-identity-staged"), "new-key");
    write(NodePath.join(secrets, "accounts-vault.bin.dev-identity-staged"), "new-sentinel");
    write(NodePath.join(secrets, "accounts-vault.bin"), "new-sentinel-already-moved");
    write(NodePath.join(secrets, "custom-model-old.bin"), "stale");
    write(
      NodePath.join(target, "dev-identity-journal.json"),
      JSON.stringify({
        writes: [
          {
            staged: NodePath.join(secrets, "accounts-master-key.bin.dev-identity-staged"),
            path: NodePath.join(secrets, "accounts-master-key.bin"),
          },
          {
            staged: NodePath.join(secrets, "accounts-vault.bin.dev-identity-staged"),
            path: NodePath.join(secrets, "accounts-vault.bin"),
          },
        ],
        removals: [NodePath.join(secrets, "custom-model-old.bin")],
      }),
    );
    const result = await importDevIdentity({
      targetStateDir: target,
      home: homeAt(NodePath.join(root, "no-home")),
    });
    assert.equal(result.status, "no-home");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(secrets, "accounts-master-key.bin"), "utf8"),
      "new-key",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(secrets, "accounts-vault.bin"), "utf8"),
      "new-sentinel",
    );
    assert.equal(NodeFS.existsSync(NodePath.join(secrets, "custom-model-old.bin")), false);
    assert.equal(NodeFS.existsSync(NodePath.join(target, "dev-identity-journal.json")), false);

    write(NodePath.join(target, "dev-identity-journal.json"), "{broken");
    const error = await importDevIdentity({
      targetStateDir: target,
      home: homeAt(NodePath.join(root, "no-home")),
    }).catch((cause) => cause);
    assert.equal(error?.fatal, true);
  });

  it("refuses a dev app whose secrets folder is a link elsewhere", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const elsewhere = NodePath.join(root, "elsewhere");
    NodeFS.mkdirSync(elsewhere);
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    NodeFS.mkdirSync(target, { recursive: true });
    NodeFS.symlinkSync(elsewhere, NodePath.join(target, "secrets"));
    const error = await importDevIdentity({ targetStateDir: target, home }).catch((cause) => cause);
    assert.equal(error?.fatal, true);
    assert.deepEqual(NodeFS.readdirSync(elsewhere), []);
  });

  it("refuses a snapshot whose settings name a stored secret that is missing", () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const redacted = "\u2022\u2022\u2022\u2022\u2022\u2022";
    write(
      NodePath.join(home.stateDir, "settings.json"),
      JSON.stringify({
        sourceControlHosts: { github: { token: { "GitHub.com ": redacted } } },
        textGenerators: { tg: { apiKey: redacted } },
        providerInstances: { claude: { driver: "claudeAgent", config: { apiKey: redacted } } },
      }),
    );
    assert.equal(captureIdentity(home.stateDir, { attempts: 1 }), undefined);
    const b = (value) => Buffer.from(value).toString("base64url");
    for (const name of [
      `source-control-${b("github")}-${b("token")}-${b("github.com")}`,
      `text-generator-${b("tg")}-${b("apiKey")}`,
      `provider-config-${b("claude")}-${b("claudeAgent")}-${b("apiKey")}`,
    ]) {
      write(NodePath.join(home.stateDir, "secrets", `${name}.bin`), "value");
    }
    assert.ok(captureIdentity(home.stateDir, { attempts: 1 }));
  });

  it("keeps plain install keys that happen to start with 0xff when the vault key changes", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const signing = Buffer.concat([Buffer.from([0xff]), NodeCrypto.randomBytes(31)]);
    write(NodePath.join(target, "secrets", "server-signing-key.bin"), signing);
    write(NodePath.join(target, "secrets", "secret-request-salt.bin"), Buffer.from([0xff, 7]));
    await importDevIdentity({ targetStateDir: target, home });
    assert.deepEqual(
      NodeFS.readFileSync(NodePath.join(target, "secrets", "server-signing-key.bin")),
      signing,
    );
    assert.ok(NodeFS.existsSync(NodePath.join(target, "secrets", "secret-request-salt.bin")));
  });

  it("drops connector Undo history and keeps connector state private", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "settings.json"), "{}");
    write(NodePath.join(target, "connector-history", "con_x", "created.json"), "{}");
    await importDevIdentity({ targetStateDir: target, home });
    assert.equal(NodeFS.existsSync(NodePath.join(target, "connector-history")), false);
    assert.equal(
      NodeFS.statSync(NodePath.join(target, "scient-extensions.json")).mode & 0o777,
      0o600,
    );
  });

  it("refreshes source-control hosts with their secret slots on every start", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    write(
      NodePath.join(home.stateDir, "settings.json"),
      JSON.stringify({ sourceControlHosts: { github: { enabled: true } } }),
    );
    write(
      NodePath.join(home.stateDir, "secrets", "source-control-Z2l0aHVi-dG9rZW4.bin"),
      "gh-token",
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "settings.json"), JSON.stringify({ sourceControlHosts: {} }));
    write(NodePath.join(target, "client-settings.json"), "{}");
    await importDevIdentity({ targetStateDir: target, home });
    assert.deepEqual(readJson(NodePath.join(target, "settings.json")).sourceControlHosts, {
      github: { enabled: true },
    });
    assert.ok(
      NodeFS.existsSync(NodePath.join(target, "secrets", "source-control-Z2l0aHVi-dG9rZW4.bin")),
    );
  });

  it("drops sharing records from copied browser profiles", () => {
    assert.deepEqual(
      scrubAccountsState({
        profiles: [{ profileId: "p", access: "ask", send: {}, sharedWith: [], received: [{}] }],
      }),
      { profiles: [{ profileId: "p", access: "ask" }] },
    );
  });

  it("reads a migrated jar and writes the jar a fresh profile opens, leaving the source alone", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const partition = NodePath.join(
      home.stateDir,
      "electron-userdata",
      "Partitions",
      previewPartitionDirectory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );
    makeCookieDatabase(NodePath.join(partition, "Network", "Cookies"), [
      { host: ".example.org", name: "session", value: "migrated" },
    ]);
    write(NodePath.join(partition, "Network", "NetworkDataMigrated"), "");
    // A stale pre-migration jar Chromium no longer opens.
    makeCookieDatabase(NodePath.join(partition, "Cookies"), [
      { host: ".example.org", name: "session", value: "stale" },
    ]);
    const sourceFiles = NodeFS.readdirSync(NodePath.join(partition, "Network")).sort();
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    await importDevIdentity({ targetStateDir: target, home });
    const environmentId = NodeFS.readFileSync(
      NodePath.join(target, "environment-id"),
      "utf8",
    ).trim();
    const targetPartition = NodePath.join(
      target,
      "electron-userdata",
      "Partitions",
      previewPartitionDirectory(environmentId),
    );
    assert.equal(cookieDatabasePath(targetPartition), NodePath.join(targetPartition, "Cookies"));
    assert.deepEqual(readCookies(NodePath.join(targetPartition, "Cookies")), [
      { name: "session", value: "migrated", sealed: 0 },
    ]);
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(partition, "Network")).sort(), sourceFiles);
  });
});

describe("cookie jar placement", () => {
  it("writes into Network/ when the target profile has already migrated there", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const homeEnvironment = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    makeCookieDatabase(
      NodePath.join(
        home.stateDir,
        "electron-userdata",
        "Partitions",
        previewPartitionDirectory(homeEnvironment),
        "Cookies",
      ),
      [{ host: ".example.org", name: "session", value: "home" }],
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "environment-id"), "cccccccc-cccc-4ccc-8ccc-cccccccccccc\n");
    const partition = NodePath.join(
      target,
      "electron-userdata",
      "Partitions",
      previewPartitionDirectory("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    );
    write(NodePath.join(partition, "Network", "NetworkDataMigrated"), "");
    await importDevIdentity({ targetStateDir: target, home });
    assert.deepEqual(readCookies(NodePath.join(partition, "Network", "Cookies")), [
      { name: "session", value: "home", sealed: 0 },
    ]);
    assert.equal(NodeFS.existsSync(NodePath.join(partition, "Cookies")), false);
  });
});

describe("third review guards", () => {
  it("does not start a home whose data folder is linked into the installed app", async () => {
    const root = scratch();
    const installedState = NodePath.join(root, "installed", "userdata");
    NodeFS.mkdirSync(installedState, { recursive: true });
    const home = homeAt(NodePath.join(root, "home"));
    NodeFS.mkdirSync(home.root, { recursive: true });
    NodeFS.symlinkSync(installedState, home.stateDir);
    const error = await importDevIdentity({
      targetStateDir: home.stateDir,
      home,
      installed: { stateDir: installedState },
    }).catch((cause) => cause);
    assert.equal(error?.fatal, true);
    assert.deepEqual(NodeFS.readdirSync(installedState), []);
  });

  it("refuses to seed while the home checkout runs an older version", async () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "scient-desktop-identity");
    write(
      NodePath.join(checkout, "scripts", "dev-identity.mjs"),
      "export const DEV_IDENTITY_PROTOCOL = 0;\n",
    );
    write(NodePath.join(home.root, "dev-identity-home.json"), JSON.stringify({ checkout }));
    const stateDir = NodePath.join(root, "installed", "userdata");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const error = await seedDevIdentityHome({
      home,
      installed: { stateDir, userData: root, vaultKeychainAccount: "a", cookieKeychains: [] },
      readKeychain: async () => null,
      isRunning: () => false,
    }).catch((cause) => cause);
    assert.match(String(error), /older dev identity version/u);
  });

  it("checks the commit has this module version before creating the home checkout", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "scient-desktop-identity");
    for (const blob of [undefined, "export const DEV_IDENTITY_PROTOCOL = 0;\n"]) {
      const calls = [];
      assert.throws(
        () =>
          setupHomeCheckout({
            repoRoot: root,
            checkout,
            ref: "abc123",
            home,
            run: (_command, args) => calls.push(args.slice(2).join(" ")),
            readGitFile: () => blob,
          }),
        /does not have this dev identity version/u,
      );
      assert.deepEqual(calls, []);
      assert.equal(NodeFS.existsSync(checkout), false);
    }
  });

  it("refuses to replay a journal whose paths now lead outside the app", async () => {
    const root = scratch();
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const outside = NodePath.join(root, "outside");
    write(NodePath.join(outside, "Cookies"), "someone else's jar");
    const network = NodePath.join(target, "electron-userdata", "Partitions", "p", "Network");
    NodeFS.mkdirSync(NodePath.dirname(network), { recursive: true });
    NodeFS.symlinkSync(outside, network);
    write(NodePath.join(outside, "Cookies.dev-identity-staged"), "replacement");
    write(
      NodePath.join(target, "dev-identity-journal.json"),
      JSON.stringify({
        writes: [
          {
            staged: NodePath.join(network, "Cookies.dev-identity-staged"),
            path: NodePath.join(network, "Cookies"),
          },
        ],
        removals: [],
      }),
    );
    const error = await importDevIdentity({
      targetStateDir: target,
      home: homeAt(NodePath.join(root, "no-home")),
    }).catch((cause) => cause);
    assert.equal(error?.fatal, true);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(outside, "Cookies"), "utf8"),
      "someone else's jar",
    );
  });
});
