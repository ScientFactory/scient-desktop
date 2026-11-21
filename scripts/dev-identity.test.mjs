import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  acquireHomeLock,
  assertHomeCheckout,
  claimHomeStart,
  cookieDatabasePath,
  captureIdentity,
  DEV_IDENTITY_ENV,
  homeIsLocked,
  DEV_IDENTITY_MARKER,
  describeImport,
  ensurePortableVault,
  importDevIdentity,
  makeChromiumCookieDecrypter,
  makePortableVault,
  homeAppIsRunning,
  prepareHomeStart,
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

const PROTOCOL_LINE = "export const DEV_IDENTITY_PROTOCOL = 2;\n";
const noOpenFiles = () => [];
const homeAt = (root) => ({ root, stateDir: NodePath.join(root, "scient-next-dev") });

/** The home's registered checkout, its app data a link to the home, as `setup` leaves it. */
function linkHomeCheckout(root, home) {
  const checkout = NodePath.join(root, "scient-desktop-identity");
  write(NodePath.join(checkout, "scripts", "dev-identity.mjs"), PROTOCOL_LINE);
  NodeFS.mkdirSync(home.root, { recursive: true });
  NodeFS.symlinkSync(home.root, NodePath.join(checkout, ".scient-next"));
  write(NodePath.join(home.root, "dev-identity-home.json"), JSON.stringify({ checkout }));
  return checkout;
}

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
    // The candidate's Keychain vault held nothing of its own, so it gets a new file key.
    const copiedKey = NodeFS.readFileSync(NodePath.join(secrets, "accounts-master-key.bin"));
    assert.equal(copiedKey.length, 32);
    assert.notDeepEqual(copiedKey, vault.key);
    const model = "custom-model-11111111-1111-4111-8111-111111111111";
    assert.equal(
      decrypt(
        copiedKey,
        model,
        NodeFS.readFileSync(NodePath.join(secrets, `${model}.bin`)).subarray(1),
      ).toString(),
      "sk-test",
    );
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
    const checkout = linkHomeCheckout(root, home);
    const leftover = NodePath.join(home.stateDir, "dev-identity-staging", "cookies-x", "Cookies");
    write(leftover, "plain jar from a seed that stopped");
    const result = await importDevIdentity({
      targetStateDir: NodePath.join(checkout, ".scient-next", "scient-next-dev"),
      home,
    });
    assert.equal(result.status, "home");
    assert.equal(NodeFS.existsSync(leftover), false);
  });

  it("refuses a second checkout whose app data is the home", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    linkHomeCheckout(root, home);
    const other = NodePath.join(root, "other", "scient-desktop-identity");
    NodeFS.mkdirSync(other, { recursive: true });
    NodeFS.symlinkSync(home.root, NodePath.join(other, ".scient-next"));
    assert.throws(
      () =>
        assertHomeCheckout({
          checkoutRoot: other,
          stateRoot: NodePath.join(other, ".scient-next"),
          home,
        }),
      /only its own checkout/u,
    );
    const error = await importDevIdentity({
      targetStateDir: NodePath.join(other, ".scient-next", "scient-next-dev"),
      home,
    }).catch((cause) => cause);
    assert.equal(error?.fatal, true);
    // An ordinary checkout is left alone.
    assertHomeCheckout({
      checkoutRoot: root,
      stateRoot: NodePath.join(root, "candidate"),
      home,
    });
  });

  it("sees the protected folders through a differently cased path", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const installedState = NodePath.join(root, "installed", "userdata");
    NodeFS.mkdirSync(installedState, { recursive: true });
    const alias = NodePath.join(root, "INSTALLED", "userdata");
    // Only meaningful where the file system ignores case, as macOS does by default.
    if (!NodeFS.existsSync(alias)) return;
    const result = await importDevIdentity({
      targetStateDir: NodePath.join(alias, "scient-next-dev"),
      home,
      installed: { stateDir: installedState },
    });
    assert.equal(result.status, "refused-target");
    assert.deepEqual(NodeFS.readdirSync(installedState), []);
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
              {
                summary: { accountId: "a" },
                values: { password: valueName },
                pendingCopies: { x: [] },
              },
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
    const targetKey = NodeFS.readFileSync(
      NodePath.join(target, "secrets", "accounts-master-key.bin"),
    );
    const readState = () =>
      JSON.parse(
        decrypt(
          targetKey,
          "accounts-state",
          NodeFS.readFileSync(NodePath.join(target, "secrets", "accounts-state.bin")),
        ).toString(),
      );
    assert.deepEqual(readState(), {
      format: 1,
      accounts: [{ summary: { accountId: "a" }, values: { password: valueName } }],
    });

    // The candidate's own senders, choices and own profiles survive the next copy, and so does an
    // account whose changed password still waits for its password store, with that password.
    const newValue = "accounts-value-66666666-6666-4666-8666-666666666666";
    write(
      NodePath.join(target, "secrets", `${newValue}.bin`),
      encrypt(targetKey, newValue, Buffer.from("new-pw")),
    );
    // The home still has the older value under the same record.
    write(
      NodePath.join(home.stateDir, "secrets", `${newValue}.bin`),
      encrypt(vault.key, newValue, Buffer.from("old-pw")),
    );
    const pendingRow = {
      summary: { accountId: "a" },
      values: { password: newValue },
      pendingCopies: { password: ["onepassword"] },
    };
    const own = {
      format: 1,
      accounts: [pendingRow],
      profiles: [
        { profileId: "p", access: "ask", sharedWith: ["env-2"] },
        { profileId: "q", access: "ask", scriptSignIn: false },
      ],
      senders: [{ source: "env-2" }],
      profileChoices: { thread: "mine" },
    };
    write(
      NodePath.join(target, "secrets", "accounts-state.bin"),
      encrypt(targetKey, "accounts-state", Buffer.from(JSON.stringify(own))),
    );
    write(
      NodePath.join(home.stateDir, "secrets", "accounts-state.bin"),
      encrypt(
        vault.key,
        "accounts-state",
        Buffer.from(
          JSON.stringify({
            format: 1,
            accounts: [
              { summary: { accountId: "a" }, values: { password: valueName } },
              { summary: { accountId: "b" }, values: {} },
            ],
            profiles: [{ profileId: "p", access: "allowed" }],
          }),
        ),
      ),
    );
    await importDevIdentity({ targetStateDir: target, home });
    assert.deepEqual(
      NodeFS.readFileSync(NodePath.join(target, "secrets", "accounts-master-key.bin")),
      targetKey,
    );
    const readValue = () =>
      decrypt(
        targetKey,
        newValue,
        NodeFS.readFileSync(NodePath.join(target, "secrets", `${newValue}.bin`)),
      ).toString();
    assert.deepEqual(readState(), {
      format: 1,
      accounts: [pendingRow, { summary: { accountId: "b" }, values: {} }],
      profiles: [
        { profileId: "p", access: "allowed", sharedWith: ["env-2"] },
        { profileId: "q", access: "ask", scriptSignIn: false },
      ],
      senders: [{ source: "env-2" }],
      profileChoices: { thread: "mine" },
    });
    assert.equal(readValue(), "new-pw");

    // A home with no Accounts document yet still leaves the candidate its own part.
    NodeFS.rmSync(NodePath.join(home.stateDir, "secrets", "accounts-state.bin"));
    await importDevIdentity({ targetStateDir: target, home });
    assert.deepEqual(readState(), {
      format: 1,
      agentAccess: true,
      accounts: [pendingRow],
      profiles: [
        { profileId: "p", access: "allowed", sharedWith: ["env-2"] },
        { profileId: "q", access: "ask", scriptSignIn: false },
      ],
      onePasswordStatus: { state: "not-connected" },
      senders: [{ source: "env-2" }],
      profileChoices: { thread: "mine" },
    });
    assert.equal(readValue(), "new-pw");
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

  it("keeps the candidate's own key and sealed records, and copies Cursor's sign-in", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const cursorSlot = `provider-auth-${NodeCrypto.createHash("sha256").update("6:cursorcursor").digest("hex")}.bin`;
    write(NodePath.join(home.stateDir, "secrets", cursorSlot), "cursor-key");
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const secrets = NodePath.join(target, "secrets");
    const own = makePortableVault();
    write(NodePath.join(secrets, "accounts-master-key.bin"), own.key);
    write(NodePath.join(secrets, "accounts-vault.bin"), own.sentinel);
    const request = "secret-request-00000000000000000000000000000000";
    const sealed = Buffer.concat([
      Buffer.from([0xff]),
      encrypt(own.key, request, Buffer.from("answer")),
    ]);
    write(NodePath.join(secrets, `${request}.bin`), sealed);
    write(NodePath.join(secrets, "secret-request-salt.bin"), "plain-salt");
    const result = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(result.status, "imported");
    const names = NodeFS.readdirSync(secrets);
    assert.include(names, cursorSlot);
    assert.include(names, "secret-request-salt.bin");
    assert.notInclude(names, "provider-auth-abc.bin");
    assert.deepEqual(
      NodeFS.readFileSync(NodePath.join(secrets, "accounts-master-key.bin")),
      own.key,
    );
    assert.deepEqual(NodeFS.readFileSync(NodePath.join(secrets, `${request}.bin`)), sealed);
    // The home's records now open under the candidate's key.
    assert.equal(
      decrypt(
        own.key,
        "accounts-state",
        NodeFS.readFileSync(NodePath.join(secrets, "accounts-state.bin")),
      ).toString(),
      "{}",
    );
  });

  it("leaves a candidate alone whose Keychain vault holds its own accounts", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const secrets = NodePath.join(target, "secrets");
    write(NodePath.join(secrets, "accounts-vault.bin"), Buffer.from([1, 9, 9]));
    write(NodePath.join(secrets, "accounts-state.bin"), "keychain-sealed");
    write(NodePath.join(target, "settings.json"), "{}");
    const before = NodeFS.readdirSync(secrets).sort();
    const result = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(result.status, "target-vault-not-portable");
    assert.match(describeImport(result), /keeps its own accounts/u);
    assert.deepEqual(NodeFS.readdirSync(secrets).sort(), before);
    assert.equal(NodeFS.readFileSync(NodePath.join(target, "settings.json"), "utf8"), "{}");
  });

  it("keeps a file key whose sentinel is missing, and refuses data with no key at all", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const secrets = NodePath.join(target, "secrets");
    const own = makePortableVault();
    write(NodePath.join(secrets, "accounts-master-key.bin"), own.key);
    const request = "secret-request-11111111111111111111111111111111";
    const sealed = Buffer.concat([
      Buffer.from([0xff]),
      encrypt(own.key, request, Buffer.from("answer")),
    ]);
    write(NodePath.join(secrets, `${request}.bin`), sealed);
    assert.equal((await importDevIdentity({ targetStateDir: target, home })).status, "imported");
    assert.deepEqual(
      NodeFS.readFileSync(NodePath.join(secrets, "accounts-master-key.bin")),
      own.key,
    );
    assert.deepEqual(NodeFS.readFileSync(NodePath.join(secrets, `${request}.bin`)), sealed);
    assert.equal(vaultProtection(target), "file");

    const keyless = NodePath.join(root, "keyless", "scient-next-dev");
    write(NodePath.join(keyless, "secrets", `${request}.bin`), sealed);
    const result = await importDevIdentity({ targetStateDir: keyless, home });
    assert.equal(result.status, "target-vault-not-portable");
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(keyless, "secrets")), [`${request}.bin`]);
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
    assert.equal(homeIsLocked(home), false);
  });

  it("holds a lock through the seed that keeps the home app from starting", async () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const checkout = linkHomeCheckout(root, home);
    const stateDir = NodePath.join(root, "installed", "userdata");
    write(NodePath.join(stateDir, "secrets", "accounts-vault.bin"), Buffer.from([1, 0]));
    let seenDuringSeed;
    await seedDevIdentityHome({
      home,
      installed: { stateDir, userData: root, vaultKeychainAccount: "a", cookieKeychains: [] },
      readKeychain: async () => {
        seenDuringSeed = await importDevIdentity({
          targetStateDir: NodePath.join(checkout, ".scient-next", "scient-next-dev"),
          home,
        });
        return null;
      },
      isRunning: () => false,
    }).catch(() => {});
    assert.deepEqual(seenDuringSeed, { status: "home-seeding" });
  });

  it("does not copy from a home whose seed stopped partway", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    // A forced reseed died after setting the home's connectors aside.
    NodeFS.renameSync(
      NodePath.join(home.stateDir, "connectors"),
      NodePath.join(home.stateDir, "connectors.dev-identity-old"),
    );
    write(
      NodePath.join(home.stateDir, "dev-identity-journal.json"),
      JSON.stringify({ writes: [], removals: [] }),
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "connectors", "mine", "connector.json"), "{}");
    write(NodePath.join(target, "settings.json"), "{}");
    const result = await importDevIdentity({ targetStateDir: target, home });
    assert.equal(result.status, "home-interrupted");
    assert.ok(NodeFS.existsSync(NodePath.join(target, "connectors", "mine", "connector.json")));
  });

  it("decrypts website sign-ins only inside the app's own data and clears what a stopped copy left", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    write(NodePath.join(home.stateDir, "environment-id"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n");
    makeCookieDatabase(
      NodePath.join(
        home.stateDir,
        "electron-userdata",
        "Partitions",
        previewPartitionDirectory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        "Cookies",
      ),
      [{ host: ".example.org", name: "session", value: "plain" }],
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    const leftover = NodePath.join(target, "dev-identity-staging", "cookies-old", "Cookies");
    write(leftover, "plain jar from a copy that stopped");
    // Cleared on the next start, even one that copies nothing.
    await importDevIdentity({
      targetStateDir: target,
      home,
      environment: { [DEV_IDENTITY_ENV]: "off" },
    });
    assert.equal(NodeFS.existsSync(leftover), false);
    // With no usable system temp folder, a copy that staged there could not finish.
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = NodePath.join(root, "no-such-temp");
    let result;
    try {
      result = await importDevIdentity({ targetStateDir: target, home });
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    assert.equal(result.websiteProfiles, 1);
    assert.equal(NodeFS.existsSync(NodePath.join(target, "dev-identity-staging")), false);
  });

  it("voids a copy when a seed publishes into the home while it is read", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    write(NodePath.join(home.stateDir, "environment-id"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n");
    makeCookieDatabase(
      NodePath.join(
        home.stateDir,
        "electron-userdata",
        "Partitions",
        previewPartitionDirectory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        "Cookies",
      ),
      [{ host: ".example.org", name: "session", value: "plain" }],
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "settings.json"), "{}");
    // The copy reads up to the cookie jar before it first waits; the seed lands then.
    const pending = importDevIdentity({ targetStateDir: target, home });
    write(NodePath.join(home.stateDir, "dev-identity.json"), JSON.stringify({ seededAt: "now" }));
    assert.deepEqual(await pending, { status: "home-busy" });
    assert.equal(NodeFS.readFileSync(NodePath.join(target, "settings.json"), "utf8"), "{}");
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(target, "secrets")), []);
  });

  it("voids a copy when a seed takes the home while it is read", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    write(NodePath.join(home.stateDir, "environment-id"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n");
    makeCookieDatabase(
      NodePath.join(
        home.stateDir,
        "electron-userdata",
        "Partitions",
        previewPartitionDirectory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        "Cookies",
      ),
      [{ host: ".example.org", name: "session", value: "plain" }],
    );
    const target = NodePath.join(root, "candidate", "scient-next-dev");
    write(NodePath.join(target, "settings.json"), "{}");
    const pending = importDevIdentity({ targetStateDir: target, home });
    // A seed holds the home, its marker not yet replaced.
    const release = acquireHomeLock(home);
    try {
      assert.deepEqual(await pending, { status: "home-busy" });
    } finally {
      release();
    }
    assert.equal(NodeFS.readFileSync(NodePath.join(target, "settings.json"), "utf8"), "{}");
  });

  it("does not move the home to another checkout while its app runs", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    linkHomeCheckout(root, home);
    const other = NodePath.join(root, "other", "scient-desktop-identity");
    write(NodePath.join(other, "scripts", "dev-identity.mjs"), PROTOCOL_LINE);
    assert.throws(
      () =>
        setupHomeCheckout({
          repoRoot: root,
          checkout: other,
          home,
          run: () => {},
          isRunning: () => true,
        }),
      /stop it there/u,
    );
    assert.equal(NodeFS.existsSync(NodePath.join(other, ".scient-next")), false);
    setupHomeCheckout({
      repoRoot: root,
      checkout: other,
      home,
      run: () => {},
      isRunning: () => false,
    });
    assert.equal(readJson(NodePath.join(home.root, "dev-identity-home.json")).checkout, other);
  });

  it("readies the home only for its own checkout, never during a seed", () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const checkout = linkHomeCheckout(root, home);
    const installed = { stateDir: NodePath.join(root, "installed", "userdata") };
    const stateRoot = NodePath.join(checkout, ".scient-next");
    // Another checkout whose state folder alone links to the home's.
    const other = NodePath.join(root, "other");
    NodeFS.mkdirSync(NodePath.join(other, ".scient-next"), { recursive: true });
    NodeFS.symlinkSync(home.stateDir, NodePath.join(other, ".scient-next", "scient-next-dev"));
    assert.throws(
      () =>
        prepareHomeStart({
          checkoutRoot: other,
          stateRoot: NodePath.join(other, ".scient-next"),
          home,
          installed,
        }),
      /only its own checkout/u,
    );
    const release = acquireHomeLock(home);
    try {
      assert.equal(
        prepareHomeStart({ checkoutRoot: checkout, stateRoot, home, installed }),
        "seeding",
      );
    } finally {
      release();
    }
    const leftover = NodePath.join(home.stateDir, "dev-identity-staging", "x");
    write(leftover, "plain");
    assert.equal(prepareHomeStart({ checkoutRoot: checkout, stateRoot, home, installed }), "ready");
    assert.equal(NodeFS.existsSync(leftover), false);
    assert.equal(
      prepareHomeStart({
        checkoutRoot: root,
        stateRoot: NodePath.join(root, "candidate"),
        home,
        installed,
      }),
      "not-home",
    );
  });

  it("keeps a home's key whose sentinel is missing when setup runs again", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const secrets = NodePath.join(home.stateDir, "secrets");
    const own = makePortableVault();
    write(NodePath.join(secrets, "accounts-master-key.bin"), own.key);
    const request = "secret-request-22222222222222222222222222222222";
    write(
      NodePath.join(secrets, `${request}.bin`),
      Buffer.concat([Buffer.from([0xff]), encrypt(own.key, request, Buffer.from("answer"))]),
    );
    assert.equal(ensurePortableVault(home.stateDir), true);
    assert.deepEqual(
      NodeFS.readFileSync(NodePath.join(secrets, "accounts-master-key.bin")),
      own.key,
    );
    assert.equal(vaultProtection(home.stateDir), "file");

    // Data with no key to open it is left as it is.
    const keyless = homeAt(NodePath.join(root, "keyless"));
    write(
      NodePath.join(keyless.stateDir, "secrets", `${request}.bin`),
      Buffer.from([0xff, 1, 2, 3]),
    );
    assert.equal(ensurePortableVault(keyless.stateDir), false);
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(keyless.stateDir, "secrets")), [
      `${request}.bin`,
    ]);
  });

  it("counts a home runner as running only while its process lives", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    assert.equal(
      homeAppIsRunning(home, () => false),
      false,
    );
    NodeFS.mkdirSync(NodePath.join(home.root, "local-dev-app-runner"), { recursive: true });
    // Still starting: no process recorded yet.
    assert.equal(
      homeAppIsRunning(home, () => false),
      true,
    );
    write(
      NodePath.join(home.root, "local-dev-app-runner", "state.json"),
      JSON.stringify({ pid: 4242 }),
    );
    assert.equal(
      homeAppIsRunning(home, () => false),
      false,
    );
    assert.equal(
      homeAppIsRunning(home, (pid) => pid === 4242),
      true,
    );
  });

  it("forgets a launcher runner that died before recording its process", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const runnerDir = NodePath.join(home.root, "local-dev-app-runner");
    NodeFS.mkdirSync(runnerDir, { recursive: true });
    const made = NodeFS.statSync(runnerDir).mtimeMs;
    assert.equal(
      homeAppIsRunning(
        home,
        () => false,
        () => made + 1_000,
      ),
      true,
    );
    assert.equal(
      homeAppIsRunning(
        home,
        () => false,
        () => made + 60_000,
      ),
      false,
    );
  });

  it("keeps a seed out while a runner holds the home, and the runner out while a seed does", async () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const checkout = linkHomeCheckout(root, home);
    const stateRoot = NodePath.join(checkout, ".scient-next");
    const installedState = NodePath.join(root, "installed", "userdata");
    write(NodePath.join(installedState, "secrets", "accounts-vault.bin"), Buffer.from([1, 0]));
    const installed = {
      stateDir: installedState,
      userData: root,
      vaultKeychainAccount: "a",
      cookieKeychains: [],
    };
    const claim = claimHomeStart({ checkoutRoot: checkout, stateRoot, home, installed });
    assert.equal(claim.status, "ready");
    const seed = () =>
      seedDevIdentityHome({
        home,
        installed,
        readKeychain: async () => null,
        force: true,
        isRunning: (target) => homeAppIsRunning(target, undefined, undefined, noOpenFiles),
      });
    assert.match(String(await seed().catch((error) => error)), /Quit Scient \(Dev\)/u);
    claim.release();
    // Released: the seed gets as far as the Keychain.
    assert.match(String(await seed().catch((error) => error)), /Keychain did not give/u);

    // A process still holding the home's databases open keeps it running, whoever started it.
    assert.equal(
      homeAppIsRunning(
        home,
        () => false,
        Date.now,
        () => [4242],
      ),
      true,
    );
    assert.equal(
      homeAppIsRunning(home, () => false, Date.now, noOpenFiles),
      false,
    );

    const release = acquireHomeLock(home);
    try {
      const blocked = claimHomeStart({ checkoutRoot: checkout, stateRoot, home, installed });
      assert.equal(blocked.status, "seeding");
      assert.deepEqual(NodeFS.readdirSync(NodePath.join(home.root, "dev-identity-runners")), []);
    } finally {
      release();
    }
  });

  it("keeps the home claimed while the runner's children outlive it", () => {
    const root = scratch();
    const { home } = makeFileVaultHome(NodePath.join(root, "home"));
    const checkout = linkHomeCheckout(root, home);
    const installed = { stateDir: NodePath.join(root, "installed", "userdata") };
    const claim = claimHomeStart({
      checkoutRoot: checkout,
      stateRoot: NodePath.join(checkout, ".scient-next"),
      home,
      installed,
      pid: 900_001,
    });
    claim.holdGroup(77);
    // The runner (900001) is gone; a process of the group it started is not.
    assert.equal(
      homeAppIsRunning(home, (pid) => pid === -77, Date.now, noOpenFiles),
      true,
    );
    assert.equal(
      homeAppIsRunning(home, () => false, Date.now, noOpenFiles),
      false,
    );
    claim.release();
    assert.equal(
      homeAppIsRunning(home, (pid) => pid === -77, Date.now, noOpenFiles),
      false,
    );
  });

  it("finishes a candidate's stopped copy before a direct start opens it", () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "candidate");
    const secrets = NodePath.join(checkout, ".scient-next", "scient-next-dev", "secrets");
    write(NodePath.join(secrets, "accounts-state.bin"), "old");
    write(NodePath.join(secrets, "accounts-state.bin.dev-identity-staged"), "new");
    write(
      NodePath.join(checkout, ".scient-next", "scient-next-dev", "dev-identity-journal.json"),
      JSON.stringify({
        writes: [
          {
            staged: NodePath.join(secrets, "accounts-state.bin.dev-identity-staged"),
            path: NodePath.join(secrets, "accounts-state.bin"),
          },
        ],
        removals: [],
      }),
    );
    const claim = claimHomeStart({
      checkoutRoot: checkout,
      stateRoot: NodePath.join(checkout, ".scient-next"),
      home,
      installed: { stateDir: NodePath.join(root, "installed", "userdata") },
    });
    assert.equal(claim.status, "not-home");
    assert.equal(NodeFS.readFileSync(NodePath.join(secrets, "accounts-state.bin"), "utf8"), "new");
  });

  it("never runs two starts' copy or recovery in one app at once", async () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const checkout = NodePath.join(root, "candidate");
    const stateDir = NodePath.join(checkout, ".scient-next", "scient-next-dev");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const installed = { stateDir: NodePath.join(root, "installed", "userdata") };
    // Another start holds the app's copy lock for a moment and notes when it lets go.
    const holdCopyLock = async (released) => {
      const holder = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          `const { DatabaseSync } = require("node:sqlite");
           const d = new DatabaseSync(${JSON.stringify(NodePath.join(stateDir, "dev-identity-copy-lock.sqlite"))});
           d.exec("BEGIN EXCLUSIVE"); console.log("held");
           setTimeout(() => {
             require("node:fs").writeFileSync(${JSON.stringify(released)}, "");
             d.exec("ROLLBACK"); d.close();
           }, 700);`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      try {
        await new Promise((resolve, reject) => {
          holder.stdout.once("data", resolve);
          holder.once("exit", () => reject(new Error("the lock holder exited before holding")));
        });
      } catch (error) {
        holder.kill("SIGKILL");
        throw error;
      }
      return holder;
    };
    for (const [name, start] of [
      [
        "direct",
        async () =>
          claimHomeStart({
            checkoutRoot: checkout,
            stateRoot: NodePath.join(checkout, ".scient-next"),
            home,
            installed,
          }),
      ],
      [
        "managed",
        () =>
          importDevIdentity({
            targetStateDir: stateDir,
            home,
            installed,
            environment: { [DEV_IDENTITY_ENV]: "off" },
          }),
      ],
    ]) {
      const released = NodePath.join(root, `released-${name}`);
      const holder = await holdCopyLock(released);
      try {
        await start();
        assert.equal(NodeFS.existsSync(released), true, name);
      } finally {
        holder.kill("SIGKILL");
      }
    }
  });

  it("frees the seed lock the moment its process dies, and never hands it to two", async () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const release = acquireHomeLock(home);
    assert.throws(() => acquireHomeLock(home), /Another seed or setup/u);
    release();
    const module = NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "dev-identity.mjs"));
    const holder = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(module.href)});
         // Kept referenced: a collected lock connection would close and free the lock.
         globalThis.release = m.acquireHomeLock(${JSON.stringify(home)}); console.log("held");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise((resolve, reject) => {
        holder.stdout.once("data", resolve);
        holder.once("exit", () => reject(new Error("the lock holder exited before holding")));
      });
      assert.equal(homeIsLocked(home), true);
    } catch (error) {
      holder.kill("SIGKILL");
      throw error;
    }
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    assert.equal(homeIsLocked(home), false);
    acquireHomeLock(home)();
  });

  it("sees another process that holds a file open in the home", async () => {
    const root = scratch();
    const home = homeAt(NodePath.join(root, "home"));
    const database = NodePath.join(home.stateDir, "statev2.sqlite");
    write(database, "");
    const holder = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `require("node:fs").openSync(${JSON.stringify(database)}, "r"); console.log("open");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise((resolve) => holder.stdout.once("data", resolve));
      assert.equal(
        homeAppIsRunning(home, () => false),
        true,
      );
    } finally {
      holder.kill("SIGKILL");
    }
    await new Promise((resolve) => holder.once("exit", resolve));
    assert.equal(
      homeAppIsRunning(home, () => false),
      false,
    );
  });

  it("never gives a home a new key over records an existing key sealed", () => {
    const root = scratch();
    const keychain = homeAt(NodePath.join(root, "keychain"));
    write(
      NodePath.join(keychain.stateDir, "secrets", "accounts-vault.bin"),
      Buffer.from([1, 9, 9]),
    );
    assert.equal(ensurePortableVault(keychain.stateDir), false);
    assert.equal(vaultProtection(keychain.stateDir), "keychain");

    const keyless = homeAt(NodePath.join(root, "keyless"));
    const model = "custom-model-77777777-7777-4777-8777-777777777777.bin";
    write(NodePath.join(keyless.stateDir, "secrets", model), Buffer.from([0xff, 1, 2, 3]));
    assert.equal(ensurePortableVault(keyless.stateDir), false);
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(keyless.stateDir, "secrets")), [model]);
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
    write(NodePath.join(target, "secrets", "custom-model-old.bin"), "old");
    write(NodePath.join(target, "settings.json"), "{}");
    // The home's connectors cannot be read, after the secrets were staged.
    const connectors = NodePath.join(home.stateDir, "connectors");
    NodeFS.chmodSync(connectors, 0o000);
    let result;
    try {
      result = await importDevIdentity({ targetStateDir: target, home });
    } finally {
      NodeFS.chmodSync(connectors, 0o700);
    }
    assert.equal(result.status, "copy-failed");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(target, "secrets", "custom-model-old.bin"), "utf8"),
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
    assert.equal((await importDevIdentity({ targetStateDir: target, home })).status, "imported");
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
