// One identity for every local dev app: candidates copy the identity home's accounts, models,
// connectors and website sign-ins one way when they start; `seed` fills the home once from the
// installed app, which it only reads. See docs/operations/local-dev-app.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

export const DEV_IDENTITY_ENV = "SCIENT_DEV_IDENTITY";
export const DEV_IDENTITY_MARKER = "dev-identity.json";
const STATE_SUBDIR = "scient-next-dev";
const PREVIEW_PARTITION_DIR_PREFIX = "scient-next-preview-";
const PROFILE_MARKER = "profile-";
const DEFAULT_BROWSER_PROFILE_ID = "default";
const VAULT_SENTINEL = "accounts-vault";
const VAULT_KEY_FILE = "accounts-master-key";
const SEALED = 0xff;

/**
 * Secret records that are the owner's identity, never the install's. Each family is replaced as a
 * set, so a dev app never keeps a record the home has removed or one sealed with another key.
 * Left out on purpose: server/guest/thread-room/MCP signing keys, cloud links, DPoP proofs,
 * managed provider sign-ins (`provider-auth-*`, refreshed in place) and `accounts-sessions/`.
 */
const IDENTITY_SECRET =
  /^(?:accounts-(?:master-key|vault|state|activity)|accounts-value-[0-9a-f-]{36}|custom-model-.+|connector-.+|provider-env-.+|provider-config-.+|text-generator-.+|overleaf-git-token-.+)\.bin$/u;
/** Records the vault encrypts directly, without the sealed-store prefix. */
const VAULT_RECORD = /^(?:accounts-(?:state|activity)|accounts-value-[0-9a-f-]{36})$/u;

/** Server settings that describe the owner's models and providers; refreshed on every start. */
export const IDENTITY_SETTINGS_KEYS = [
  "customModels",
  "providerInstances",
  "favorites",
  "providerModelPreferences",
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "textGenerators",
];
/** Server settings tied to this install's projects and threads; never copied. */
const LOCAL_SETTINGS_KEYS = new Set([
  "projectSettingsOverrides",
  "projectSettingsFolded",
  "threadSections",
  "threadSectionsGeneralIndex",
  "usageAccountingSources",
]);
/** Folders and files copied once, when a dev app starts for the first time. */
const PROFILE_PATHS = ["keybindings.json", "themes", "skills", "personal-skills.json"];
const CONNECTOR_PATHS = ["scient-extensions.json", "connectors"];

export function resolveDevIdentityHome(homeDir = NodeOS.homedir()) {
  const root = NodePath.join(homeDir, ".scient-next", "dev-identity");
  return { root, stateDir: NodePath.join(root, STATE_SUBDIR) };
}

const exists = (path) => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const realpathOrSelf = (path) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

const readJsonObject = (path) => {
  try {
    const value = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** Replace a file the way the app does: write beside it, then rename over it. */
function writeFileAtomic(path, data, mode = 0o600) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temporary, data, { mode });
  NodeFS.renameSync(temporary, path);
}

const writeJsonAtomic = (path, value) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o644);

function copyTree(source, destination) {
  NodeFS.rmSync(destination, { recursive: true, force: true });
  NodeFS.cpSync(source, destination, { recursive: true, errorOnExist: false, force: true });
}

/** The vault opens a file-protected key without the Keychain: the only kind a dev app can copy. */
export function vaultProtection(stateDir) {
  const secrets = NodePath.join(stateDir, "secrets");
  let sentinel;
  try {
    sentinel = NodeFS.readFileSync(NodePath.join(secrets, `${VAULT_SENTINEL}.bin`));
  } catch {
    return "none";
  }
  if (sentinel[0] === 1) return "keychain";
  return sentinel[0] === 0 && exists(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`))
    ? "file"
    : "unreadable";
}

function identitySecretNames(secretsDir) {
  try {
    return NodeFS.readdirSync(secretsDir).filter((name) => IDENTITY_SECRET.test(name));
  } catch {
    return [];
  }
}

function replaceIdentitySecrets(sourceSecrets, targetSecrets, transform = (_name, bytes) => bytes) {
  NodeFS.mkdirSync(targetSecrets, { recursive: true, mode: 0o700 });
  for (const name of identitySecretNames(targetSecrets)) {
    NodeFS.rmSync(NodePath.join(targetSecrets, name), { force: true });
  }
  const copied = [];
  for (const name of identitySecretNames(sourceSecrets)) {
    const bytes = transform(name, NodeFS.readFileSync(NodePath.join(sourceSecrets, name)));
    if (bytes === undefined) continue;
    writeFileAtomic(NodePath.join(targetSecrets, name), bytes);
    copied.push(name);
  }
  return copied;
}

function mergeSettings(sourcePath, targetPath, { fullProfile }) {
  const source = readJsonObject(sourcePath);
  if (source === undefined) return false;
  const target = readJsonObject(targetPath) ?? {};
  const next = { ...target };
  const keys = fullProfile
    ? Object.keys(source).filter((key) => !LOCAL_SETTINGS_KEYS.has(key))
    : IDENTITY_SETTINGS_KEYS;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) next[key] = source[key];
    else delete next[key];
  }
  writeJsonAtomic(targetPath, next);
  return true;
}

/** Same bytes BrowserSession hashes: a backslash is escaped, and so is a lone UTF-16 surrogate. */
const encodeScopeForDigest = (scope) =>
  scope
    .replace(/\\/gu, "\\\\")
    .replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );

/** The folder Electron keeps a preview profile's site data in (partition name minus `persist:`). */
export function previewPartitionDirectory(environmentId, profileId) {
  const named = profileId !== undefined && profileId !== DEFAULT_BROWSER_PROFILE_ID;
  const scope = named ? JSON.stringify([environmentId, profileId]) : environmentId;
  const digest = NodeCrypto.createHash("sha256").update(encodeScopeForDigest(scope)).digest("hex");
  return `${PREVIEW_PARTITION_DIR_PREFIX}${named ? PROFILE_MARKER : ""}${digest.slice(0, 20)}`;
}

const readEnvironmentId = (stateDir) => {
  try {
    const value = NodeFS.readFileSync(NodePath.join(stateDir, "environment-id"), "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
};

/** A new dev app gets its id now, so its website sign-ins can be placed before it first runs. */
function ensureEnvironmentId(stateDir) {
  const existing = readEnvironmentId(stateDir);
  if (existing !== undefined) return existing;
  const generated = NodeCrypto.randomUUID();
  NodeFS.mkdirSync(stateDir, { recursive: true });
  try {
    NodeFS.writeFileSync(NodePath.join(stateDir, "environment-id"), `${generated}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return readEnvironmentId(stateDir) ?? generated;
}

const browserProfileIds = (clientSettingsPath) => {
  const profiles = readJsonObject(clientSettingsPath)?.browserProfiles;
  return Array.isArray(profiles)
    ? profiles.map((profile) => profile?.id).filter((id) => typeof id === "string")
    : [];
};

/** Maps each source partition folder to the folder the same profile uses in the target. */
export function mapPreviewPartitions({ sourceEnvironmentId, targetEnvironmentId, profileIds }) {
  const mapping = new Map();
  for (const profileId of [DEFAULT_BROWSER_PROFILE_ID, ...profileIds]) {
    mapping.set(
      previewPartitionDirectory(sourceEnvironmentId, profileId),
      previewPartitionDirectory(targetEnvironmentId, profileId),
    );
  }
  return mapping;
}

/** A consistent copy of a cookie database, even while its app is writing to it. */
async function backupDatabase(sourcePath, destinationPath) {
  NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true, mode: 0o700 });
  NodeFS.rmSync(destinationPath, { force: true });
  NodeFS.rmSync(`${destinationPath}-journal`, { force: true });
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    await NodeSqlite.backup(source, destinationPath);
  } finally {
    source.close();
  }
  NodeFS.chmodSync(destinationPath, 0o600);
}

const cookieDatabase = (partitionDir) =>
  [NodePath.join(partitionDir, "Network", "Cookies"), NodePath.join(partitionDir, "Cookies")].find(
    exists,
  );

/**
 * Copies website sign-ins into profiles the target has never opened. A profile the target
 * already uses keeps its own sign-ins.
 */
async function copyWebsiteSignIns({ source, target, profileIds, decrypt }) {
  const sourcePartitions = NodePath.join(source.userData, "Partitions");
  let entries;
  try {
    entries = NodeFS.readdirSync(sourcePartitions).filter((name) =>
      name.startsWith(PREVIEW_PARTITION_DIR_PREFIX),
    );
  } catch {
    return [];
  }
  const mapping = mapPreviewPartitions({
    sourceEnvironmentId: source.environmentId,
    targetEnvironmentId: target.environmentId,
    profileIds,
  });
  const copied = [];
  for (const name of entries) {
    const from = cookieDatabase(NodePath.join(sourcePartitions, name));
    if (from === undefined) continue;
    const targetName = mapping.get(name) ?? name;
    const targetDir = NodePath.join(target.userData, "Partitions", targetName);
    if (exists(targetDir)) continue;
    const to = NodePath.join(
      targetDir,
      NodePath.relative(NodePath.join(sourcePartitions, name), from),
    );
    await backupDatabase(from, to);
    if (decrypt) decryptCookieDatabase(to, decrypt);
    copied.push(targetName);
  }
  return copied;
}

/**
 * Copies the home's identity into a dev app that is about to start. Runs while no app of that
 * checkout is running; the home may be running, since every file it writes is replaced whole.
 */
export async function importDevIdentity({
  targetStateDir,
  home = resolveDevIdentityHome(),
  environment = process.env,
  now = () => new Date(),
} = {}) {
  if (environment[DEV_IDENTITY_ENV] === "off") return { status: "disabled" };
  if (realpathOrSelf(NodePath.dirname(targetStateDir)) === realpathOrSelf(home.root)) {
    return { status: "home" };
  }
  if (!exists(home.stateDir)) return { status: "no-home" };
  const protection = vaultProtection(home.stateDir);
  if (protection !== "file" && protection !== "none") {
    return { status: "home-vault-not-portable", protection };
  }
  const firstStart =
    !exists(NodePath.join(targetStateDir, "settings.json")) &&
    !exists(NodePath.join(targetStateDir, "client-settings.json"));
  NodeFS.mkdirSync(targetStateDir, { recursive: true });

  const secrets =
    protection === "file"
      ? replaceIdentitySecrets(
          NodePath.join(home.stateDir, "secrets"),
          NodePath.join(targetStateDir, "secrets"),
        )
      : [];
  mergeSettings(
    NodePath.join(home.stateDir, "settings.json"),
    NodePath.join(targetStateDir, "settings.json"),
    { fullProfile: firstStart },
  );
  for (const path of CONNECTOR_PATHS) {
    const from = NodePath.join(home.stateDir, path);
    const to = NodePath.join(targetStateDir, path);
    if (exists(from)) copyTree(from, to);
    else NodeFS.rmSync(to, { recursive: true, force: true });
  }

  const homeClientSettings = NodePath.join(home.stateDir, "client-settings.json");
  const targetClientSettings = NodePath.join(targetStateDir, "client-settings.json");
  if (firstStart) {
    for (const path of PROFILE_PATHS) {
      const from = NodePath.join(home.stateDir, path);
      if (exists(from)) copyTree(from, NodePath.join(targetStateDir, path));
    }
    if (exists(homeClientSettings)) copyTree(homeClientSettings, targetClientSettings);
  }

  const homeEnvironmentId = readEnvironmentId(home.stateDir);
  const websites =
    homeEnvironmentId === undefined
      ? []
      : await copyWebsiteSignIns({
          source: {
            userData: NodePath.join(home.stateDir, "electron-userdata"),
            environmentId: homeEnvironmentId,
          },
          target: {
            userData: NodePath.join(targetStateDir, "electron-userdata"),
            environmentId: ensureEnvironmentId(targetStateDir),
          },
          profileIds: browserProfileIds(targetClientSettings),
        });

  const summary = {
    status: "imported",
    importedAt: now().toISOString(),
    home: home.root,
    firstStart,
    secrets: secrets.length,
    websiteProfiles: websites.length,
  };
  writeJsonAtomic(NodePath.join(targetStateDir, DEV_IDENTITY_MARKER), summary);
  return summary;
}

export function describeImport(result) {
  switch (result.status) {
    case "imported":
      return `Copied your dev identity from ${result.home}: ${String(result.secrets)} saved secrets, settings and connectors${
        result.websiteProfiles > 0
          ? `, website sign-ins for ${String(result.websiteProfiles)} browser profile${result.websiteProfiles === 1 ? "" : "s"}`
          : ""
      }.`;
    case "no-home":
      return "No dev identity home yet (pnpm dev:identity setup); this dev app starts with its own accounts.";
    case "home-vault-not-portable":
      return "The dev identity home keeps its accounts key in the Keychain, which other dev apps cannot open; run pnpm dev:identity seed to move it to a shared key. Starting with this app's own accounts.";
    case "disabled":
      return `${DEV_IDENTITY_ENV}=off: this dev app keeps its own accounts.`;
    default:
      return undefined;
  }
}

const vaultEncrypt = (key, name, value) => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
};

const vaultDecrypt = (key, name, blob) => {
  if (blob[0] !== 1 || blob.length < 29) throw new Error(`${name} is not a vault record.`);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
};

/** A fresh file-protected vault: the key file plus the sentinel the vault checks it against. */
export function makePortableVault() {
  const key = NodeCrypto.randomBytes(32);
  const sentinel = Buffer.concat([
    Buffer.from([0]),
    vaultEncrypt(key, VAULT_SENTINEL, Buffer.alloc(0)),
  ]);
  return { key, sentinel };
}

/** Re-encrypts one identity record from the source vault key to the target vault key. */
export function reencryptSecret(name, bytes, sourceKey, targetKey) {
  const record = name.replace(/\.bin$/u, "");
  if (record === VAULT_SENTINEL || record === VAULT_KEY_FILE) return undefined;
  if (VAULT_RECORD.test(record)) {
    return vaultEncrypt(targetKey, record, vaultDecrypt(sourceKey, record, bytes));
  }
  if (bytes[0] === SEALED) {
    const value = vaultDecrypt(sourceKey, record, bytes.subarray(1));
    return Buffer.concat([Buffer.from([SEALED]), vaultEncrypt(targetKey, record, value)]);
  }
  return bytes;
}

/** Chromium on macOS: AES-128-CBC under PBKDF2(Safe Storage secret); v24+ prefixes SHA-256(host). */
export function makeChromiumCookieDecrypter(safeStorageSecret) {
  const key = NodeCrypto.pbkdf2Sync(safeStorageSecret, "saltysalt", 1003, 16, "sha1");
  return (encrypted, { hashPrefix }) => {
    if (encrypted.length === 0) return undefined;
    if (encrypted.subarray(0, 3).toString("latin1") !== "v10") return undefined;
    const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return (hashPrefix ? plain.subarray(32) : plain).toString("utf8");
  };
}

/** Rewrites a copied cookie database with plain values, which a dev app reads without a key. */
export function decryptCookieDatabase(path, decrypt) {
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    const version = Number(
      database.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0,
    );
    const rows = database
      .prepare("SELECT rowid, encrypted_value FROM cookies WHERE length(encrypted_value) > 0")
      .all();
    const update = database.prepare(
      "UPDATE cookies SET value = ?, encrypted_value = X'' WHERE rowid = ?",
    );
    const remove = database.prepare("DELETE FROM cookies WHERE rowid = ?");
    database.exec("BEGIN");
    for (const row of rows) {
      let value;
      try {
        value = decrypt(Buffer.from(row.encrypted_value), { hashPrefix: version >= 24 });
      } catch {
        value = undefined;
      }
      if (value === undefined) remove.run(row.rowid);
      else update.run(value, row.rowid);
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

export function resolveInstalledApp(homeDir = NodeOS.homedir()) {
  const stateDir = NodePath.join(homeDir, ".scient-next", "userdata");
  return {
    stateDir,
    userData: NodePath.join(homeDir, "Library", "Application Support", "scient-next"),
    vaultKeychainAccount: NodeCrypto.createHash("sha256").update(stateDir).digest("hex"),
    // Electron names the cookie key after the package: `<name> Safe Storage` / `<name> Key`.
    cookieKeychain: { service: "scient-next Safe Storage", account: "scient-next Key" },
  };
}

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/** The home's app writes its own files; seeding or moving it waits until it is closed. */
export function homeAppIsRunning(home = resolveDevIdentityHome(), isAlive = processIsAlive) {
  for (const file of ["electron.pid", "backend.pid"]) {
    try {
      const pid = Number.parseInt(
        NodeFS.readFileSync(NodePath.join(home.root, "local-dev-app-runtime", file), "utf8"),
        10,
      );
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return true;
    } catch {
      // No pid file: that process is not running.
    }
  }
  return exists(NodePath.join(home.root, "local-dev-app-runner", "state.json"));
}

/**
 * Fills the home from the installed app. `readKeychain(service, account)` returns a secret string
 * or null; macOS asks the owner once for each item.
 */
export async function seedDevIdentityHome({
  home = resolveDevIdentityHome(),
  installed = resolveInstalledApp(),
  readKeychain,
  force = false,
  isRunning = homeAppIsRunning,
} = {}) {
  if (isRunning(home)) {
    throw new Error("Quit Scient (Dev) · identity first (pnpm dev:app:stop in its checkout).");
  }
  const marker = readJsonObject(NodePath.join(home.stateDir, DEV_IDENTITY_MARKER));
  if (marker?.seededFrom !== undefined && !force) {
    throw new Error(
      `The dev identity home was already seeded on ${String(marker.seededAt)}. Pass --force to replace its accounts with the installed app's again.`,
    );
  }
  if (!exists(installed.stateDir))
    throw new Error(`No installed Scient data at ${installed.stateDir}.`);
  NodeFS.mkdirSync(home.stateDir, { recursive: true, mode: 0o700 });
  const report = { secrets: 0, websiteProfiles: 0, skipped: [] };

  const protection = vaultProtection(installed.stateDir);
  let sourceKey;
  if (protection === "file") {
    sourceKey = NodeFS.readFileSync(
      NodePath.join(installed.stateDir, "secrets", `${VAULT_KEY_FILE}.bin`),
    );
  } else if (protection === "keychain") {
    const encoded = await readKeychain("Scient Accounts", installed.vaultKeychainAccount);
    if (encoded) sourceKey = Buffer.from(encoded, "base64");
  }
  if (sourceKey?.length === 32) {
    const sentinel = NodeFS.readFileSync(
      NodePath.join(installed.stateDir, "secrets", `${VAULT_SENTINEL}.bin`),
    );
    vaultDecrypt(sourceKey, VAULT_SENTINEL, sentinel.subarray(1));
    const vault = makePortableVault();
    const targetSecrets = NodePath.join(home.stateDir, "secrets");
    const copied = replaceIdentitySecrets(
      NodePath.join(installed.stateDir, "secrets"),
      targetSecrets,
      (name, bytes) => {
        try {
          return reencryptSecret(name, bytes, sourceKey, vault.key);
        } catch {
          report.skipped.push(name.replace(/\.bin$/u, ""));
          return undefined;
        }
      },
    );
    writeFileAtomic(NodePath.join(targetSecrets, `${VAULT_KEY_FILE}.bin`), vault.key);
    writeFileAtomic(NodePath.join(targetSecrets, `${VAULT_SENTINEL}.bin`), vault.sentinel);
    report.secrets = copied.length;
  } else {
    report.skipped.push("accounts (the Keychain did not give the installed app's key)");
  }

  mergeSettings(
    NodePath.join(installed.stateDir, "settings.json"),
    NodePath.join(home.stateDir, "settings.json"),
    { fullProfile: true },
  );
  for (const path of [...CONNECTOR_PATHS, ...PROFILE_PATHS, "client-settings.json"]) {
    const from = NodePath.join(installed.stateDir, path);
    if (exists(from)) copyTree(from, NodePath.join(home.stateDir, path));
  }

  const installedEnvironmentId = readEnvironmentId(installed.stateDir);
  const cookieSecret = await readKeychain(
    installed.cookieKeychain.service,
    installed.cookieKeychain.account,
  );
  if (installedEnvironmentId !== undefined && cookieSecret) {
    const websites = await copyWebsiteSignIns({
      source: { userData: installed.userData, environmentId: installedEnvironmentId },
      target: {
        userData: NodePath.join(home.stateDir, "electron-userdata"),
        environmentId: ensureEnvironmentId(home.stateDir),
      },
      profileIds: browserProfileIds(NodePath.join(home.stateDir, "client-settings.json")),
      decrypt: makeChromiumCookieDecrypter(cookieSecret),
    });
    report.websiteProfiles = websites.length;
  } else {
    report.skipped.push("website sign-ins (the Keychain did not give the installed app's key)");
  }

  writeJsonAtomic(NodePath.join(home.stateDir, DEV_IDENTITY_MARKER), {
    seededFrom: installed.stateDir,
    seededAt: new Date().toISOString(),
    secrets: report.secrets,
    websiteProfiles: report.websiteProfiles,
    skipped: report.skipped,
  });
  return report;
}

/**
 * Makes the checkout the home app runs from: a detached worktree of this clone at origin/main,
 * named so the app is labelled "identity". Its `.scient-next` points at the home, so removing or
 * recreating the checkout never loses the owner's accounts.
 */
export function setupHomeCheckout({
  repoRoot,
  checkout,
  home = resolveDevIdentityHome(),
  run = (command, args, options) =>
    NodeChildProcess.execFileSync(command, args, { stdio: "inherit", ...options }),
}) {
  if (NodePath.basename(checkout) !== "scient-desktop-identity") {
    throw new Error("The home checkout folder must be named scient-desktop-identity.");
  }
  NodeFS.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  if (!exists(checkout)) {
    run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", "main"]);
    run("git", ["-C", repoRoot, "worktree", "add", "--detach", checkout, "origin/main"]);
  }
  const link = NodePath.join(checkout, ".scient-next");
  if (exists(link) && !NodeFS.lstatSync(link).isSymbolicLink()) {
    throw new Error(
      `${link} already holds an app's data; move it aside before using this checkout.`,
    );
  }
  if (!exists(link)) NodeFS.symlinkSync(home.root, link);
  return { checkout, home: home.root };
}

/** Reads one Keychain item through the server's own keyring module. */
export async function readKeychainWithKeyring(service, account, repoRoot) {
  const require = NodeModule.createRequire(
    NodePath.join(repoRoot, "apps", "server", "package.json"),
  );
  const { AsyncEntry } = require("@napi-rs/keyring");
  return (await new AsyncEntry(service, account).getPassword()) ?? null;
}

const isMain = process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const [command, ...flags] = process.argv.slice(2);
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const run = async () => {
    if (command === "seed") {
      const report = await seedDevIdentityHome({
        readKeychain: (service, account) => readKeychainWithKeyring(service, account, repoRoot),
        force: flags.includes("--force"),
      });
      console.log(
        `Seeded the dev identity home from the installed app: ${String(report.secrets)} saved secrets, settings, connectors and website sign-ins for ${String(report.websiteProfiles)} browser profiles.`,
      );
      for (const item of report.skipped) console.log(`Not copied: ${item}.`);
      return;
    }
    if (command === "setup") {
      const at = flags.indexOf("--checkout");
      const checkout = NodePath.resolve(
        at >= 0 && flags[at + 1]
          ? flags[at + 1]
          : NodePath.join(NodeOS.homedir(), "scient-desktop-identity"),
      );
      setupHomeCheckout({ repoRoot, checkout });
      console.log(
        `Identity home checkout ready at ${checkout}. Start it with: cd ${checkout} && pnpm install && pnpm dev:app:start`,
      );
      return;
    }
    if (command === "status") {
      const home = resolveDevIdentityHome();
      const marker = readJsonObject(NodePath.join(home.stateDir, DEV_IDENTITY_MARKER));
      console.log(
        exists(home.stateDir)
          ? `Dev identity home: ${home.root} (accounts key: ${vaultProtection(home.stateDir)}${
              marker?.seededAt ? `, seeded ${String(marker.seededAt)}` : ""
            }).`
          : `No dev identity home at ${home.root}.`,
      );
      return;
    }
    throw new Error("Usage: pnpm dev:identity setup [--checkout <path>] | seed [--force] | status");
  };
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
