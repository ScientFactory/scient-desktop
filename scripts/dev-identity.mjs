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
const HOME_RECORD = "dev-identity-home.json";
const HOME_CHECKOUT_NAME = "scient-desktop-identity";
const STATE_SUBDIR = "scient-next-dev";
const PREVIEW_PARTITION_DIR_PREFIX = "scient-next-preview-";
const PROFILE_MARKER = "profile-";
const DEFAULT_BROWSER_PROFILE_ID = "default";
const VAULT_SENTINEL = "accounts-vault";
const VAULT_KEY_FILE = "accounts-master-key";
const ACCOUNTS_STATE = "accounts-state";
const SEALED = 0xff;
const CAPTURE_ATTEMPTS = 5;

/**
 * Secret records that are the owner's identity, never the install's. Each family is replaced as a
 * set. Left out: signing keys, cloud links, DPoP proofs, inbound `mcp-oauth-*`, managed Codex
 * sign-ins in `provider-auth-*` (Cursor's are added by name) and `accounts-sessions/`.
 */
const IDENTITY_SECRET =
  /^(?:accounts-(?:master-key|vault|state|activity)|accounts-value-[0-9a-f-]{36}|custom-model-.+|connector-.+|provider-env-.+|provider-config-.+|text-generator-.+|overleaf-git-token-.+|source-control-.+)\.bin$/u;
/** Records the vault encrypts directly, without the sealed-store prefix. */
const VAULT_RECORD = /^(?:accounts-(?:state|activity)|accounts-value-[0-9a-f-]{36})$/u;
/** A reference from settings, connectors or Accounts to a record that must travel with it. */
const RECORD_REFERENCE = /^(?:accounts-value|connector|custom-model)-[0-9a-f-]{36}$/u;

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
/** Accounts state that belongs to the install holding it, not to the owner. */
const LOCAL_ACCOUNTS_KEYS = ["senders", "senderKeys", "profileChoices"];
/** Folders and files copied once, when a dev app starts for the first time. */
const PROFILE_PATHS = ["keybindings.json", "themes", "skills", "personal-skills.json"];

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

const parseJsonObject = (text) => {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const readText = (path) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const readBytes = (path) => {
  try {
    return NodeFS.readFileSync(path);
  } catch {
    return undefined;
  }
};

const readJsonObject = (path) => {
  const text = readText(path);
  return text === undefined ? undefined : parseJsonObject(text);
};

/** Replace a file the way the app does: write beside it, then rename over it. */
function writeFileAtomic(path, data, mode = 0o600) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temporary, data, { mode });
  NodeFS.renameSync(temporary, path);
}

const writeJsonAtomic = (path, value, mode = 0o644) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);

function copyTree(source, destination) {
  NodeFS.rmSync(destination, { recursive: true, force: true });
  NodeFS.cpSync(source, destination, { recursive: true, errorOnExist: false, force: true });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const mapStrings = (value, map) => {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]),
    );
  }
  return value;
};

const collectStrings = (value, into = []) => {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
};

/** Paths that pointed into the source app's state now point into the target's. */
export function rebasePaths(value, sourceDirs, targetDir) {
  return mapStrings(value, (text) => {
    for (const source of sourceDirs) {
      if (text === source) return targetDir;
      if (text.startsWith(`${source}/`)) return `${targetDir}${text.slice(source.length)}`;
    }
    return text;
  });
}

/** A connector folder outside this app's state is never this app's to delete. */
export function disownOutsideFolders(value, stateDir) {
  if (Array.isArray(value)) return value.map((item) => disownOutsideFolders(item, stateDir));
  if (value === null || typeof value !== "object") return value;
  const next = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, disownOutsideFolders(item, stateDir)]),
  );
  if (
    next.owned === true &&
    typeof next.directory === "string" &&
    !next.directory.startsWith(`${stateDir}/`)
  ) {
    next.owned = false;
  }
  return next;
}

/** The vault opens a file-protected key without the Keychain: the only kind a dev app can copy. */
export function vaultProtection(stateDir) {
  const secrets = NodePath.join(stateDir, "secrets");
  const sentinel = readBytes(NodePath.join(secrets, `${VAULT_SENTINEL}.bin`));
  if (sentinel === undefined) return "none";
  if (sentinel[0] === 1) return "keychain";
  return sentinel[0] === 0 && exists(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`))
    ? "file"
    : "unreadable";
}

/** Same name `ProviderCredentialStore` gives a provider instance's sign-in slot. */
const providerAuthName = (driver, instanceId) =>
  `provider-auth-${NodeCrypto.createHash("sha256")
    .update(`${String(driver.length)}:${driver}${instanceId}`)
    .digest("hex")}.bin`;

/** Cursor keeps a fixed API key in its slot; Codex's managed sign-in is refreshed in place. */
function portableProviderAuthNames(settings) {
  const instances = settings?.providerInstances;
  const names = new Set([providerAuthName("cursor", "cursor")]);
  if (instances !== null && typeof instances === "object") {
    for (const [id, instance] of Object.entries(instances)) {
      if (instance?.driver === "cursor") names.add(providerAuthName("cursor", id));
    }
  }
  return names;
}

function identitySecretNames(secretsDir, settings) {
  const providerAuth = portableProviderAuthNames(settings);
  try {
    return NodeFS.readdirSync(secretsDir).filter(
      (name) => IDENTITY_SECRET.test(name) || providerAuth.has(name),
    );
  } catch {
    return [];
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

/** Gives a home without accounts a file key before its first launch would make a Keychain one. */
export function ensurePortableVault(stateDir) {
  if (vaultProtection(stateDir) !== "none") return false;
  const secrets = NodePath.join(stateDir, "secrets");
  if (exists(NodePath.join(secrets, `${ACCOUNTS_STATE}.bin`))) return false;
  const vault = makePortableVault();
  writeFileAtomic(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`), vault.key);
  writeFileAtomic(NodePath.join(secrets, `${VAULT_SENTINEL}.bin`), vault.sentinel);
  return true;
}

const vaultKeyOf = (secrets) => secrets.get(`${VAULT_KEY_FILE}.bin`);

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

/** The owner's accounts, without the senders, keys and choices that belong to the source install. */
export function scrubAccountsState(state) {
  const next = { ...state };
  for (const key of LOCAL_ACCOUNTS_KEYS) delete next[key];
  if (Array.isArray(next.accounts)) {
    next.accounts = next.accounts.map((account) => {
      if (account === null || typeof account !== "object") return account;
      const { pendingCopies: _pending, ...rest } = account;
      return rest;
    });
  }
  return next;
}

/**
 * Reads one app's identity as a single consistent snapshot. Accounts and connectors write a value
 * before publishing its reference, so the snapshot is retaken until the anchors stayed the same
 * across the read and every reference resolves.
 */
export function captureIdentity(
  stateDir,
  { vaultKey, attempts = CAPTURE_ATTEMPTS, afterRead = () => {} } = {},
) {
  const secretsDir = NodePath.join(stateDir, "secrets");
  const anchors = () =>
    [
      readBytes(NodePath.join(secretsDir, `${ACCOUNTS_STATE}.bin`)),
      readBytes(NodePath.join(stateDir, "settings.json")),
      readBytes(NodePath.join(stateDir, "scient-extensions.json")),
    ].map((bytes) => (bytes === undefined ? "" : bytes.toString("base64")));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) sleep(100 * attempt);
    const before = anchors();
    const settingsText = readText(NodePath.join(stateDir, "settings.json"));
    const extensionsText = readText(NodePath.join(stateDir, "scient-extensions.json"));
    const settings = settingsText === undefined ? undefined : parseJsonObject(settingsText);
    const extensions = extensionsText === undefined ? undefined : parseJsonObject(extensionsText);
    const secrets = new Map();
    for (const name of identitySecretNames(secretsDir, settings)) {
      const bytes = readBytes(NodePath.join(secretsDir, name));
      if (bytes !== undefined) secrets.set(name, bytes);
    }
    afterRead(attempt);
    if (before.join() !== anchors().join()) continue;
    const key = vaultKey ?? vaultKeyOf(secrets);
    let accounts;
    const stateBlob = secrets.get(`${ACCOUNTS_STATE}.bin`);
    if (stateBlob !== undefined && key !== undefined) {
      try {
        accounts = JSON.parse(vaultDecrypt(key, ACCOUNTS_STATE, stateBlob).toString("utf8"));
      } catch {
        continue;
      }
    }
    const capture = { stateDir, secrets, settings, extensions, accounts };
    const dangling = collectStrings([settings, extensions, accounts]).filter(
      (text) => RECORD_REFERENCE.test(text) && !secrets.has(`${text}.bin`),
    );
    // A reference that stays missing across every read was already missing in the source.
    if (dangling.length === 0 || attempt === attempts - 1) return capture;
  }
  return undefined;
}

/**
 * Writes a captured identity into a target, re-encrypting each record when `targetKey` is a new
 * key. The Accounts document is rewritten without the source install's senders and choices.
 */
function installSecrets({ capture, targetStateDir, targetKey, onSkip = () => {} }) {
  const targetSecrets = NodePath.join(targetStateDir, "secrets");
  NodeFS.mkdirSync(targetSecrets, { recursive: true, mode: 0o700 });
  const previousKey = readBytes(NodePath.join(targetSecrets, `${VAULT_KEY_FILE}.bin`));
  const sourceKey = vaultKeyOf(capture.secrets) ?? targetKey;
  const key = targetKey ?? sourceKey;
  const removed = new Set(
    identitySecretNames(
      targetSecrets,
      readJsonObject(NodePath.join(targetStateDir, "settings.json")),
    ),
  );
  // Records the old key sealed can no longer be opened once the key changes.
  if (previousKey === undefined || key === undefined || !previousKey.equals(key)) {
    for (const name of NodeFS.readdirSync(targetSecrets)) {
      if (!name.endsWith(".bin") || removed.has(name)) continue;
      if (readBytes(NodePath.join(targetSecrets, name))?.[0] === SEALED) removed.add(name);
    }
  }
  for (const name of removed) NodeFS.rmSync(NodePath.join(targetSecrets, name), { force: true });
  const written = [];
  for (const [name, bytes] of capture.secrets) {
    let output = bytes;
    try {
      if (name === `${ACCOUNTS_STATE}.bin` && capture.accounts !== undefined) {
        output = vaultEncrypt(
          key,
          ACCOUNTS_STATE,
          Buffer.from(JSON.stringify(scrubAccountsState(capture.accounts))),
        );
      } else if (targetKey !== undefined) {
        output = reencryptSecret(name, bytes, sourceKey, targetKey);
      }
    } catch {
      onSkip(name.replace(/\.bin$/u, ""));
      continue;
    }
    if (output === undefined) continue;
    writeFileAtomic(NodePath.join(targetSecrets, name), output);
    written.push(name);
  }
  if (targetKey !== undefined) {
    const sentinel = Buffer.concat([
      Buffer.from([0]),
      vaultEncrypt(targetKey, VAULT_SENTINEL, Buffer.alloc(0)),
    ]);
    writeFileAtomic(NodePath.join(targetSecrets, `${VAULT_KEY_FILE}.bin`), targetKey);
    writeFileAtomic(NodePath.join(targetSecrets, `${VAULT_SENTINEL}.bin`), sentinel);
  }
  return written.filter(
    (name) => !name.startsWith(VAULT_SENTINEL) && !name.startsWith(VAULT_KEY_FILE),
  );
}

function installSettings({ capture, targetStateDir, sourceDirs, targetDir, fullProfile }) {
  if (capture.settings === undefined) return;
  const source = rebasePaths(capture.settings, sourceDirs, targetDir);
  const targetPath = NodePath.join(targetStateDir, "settings.json");
  const next = { ...readJsonObject(targetPath) };
  const keys = fullProfile
    ? Object.keys(source).filter((key) => !LOCAL_SETTINGS_KEYS.has(key))
    : IDENTITY_SETTINGS_KEYS;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) next[key] = source[key];
    else delete next[key];
  }
  writeJsonAtomic(targetPath, next);
}

function installConnectors({ capture, targetStateDir, sourceDirs, targetDir }) {
  const from = NodePath.join(capture.stateDir, "connectors");
  const to = NodePath.join(targetStateDir, "connectors");
  if (exists(from)) copyTree(from, to);
  else NodeFS.rmSync(to, { recursive: true, force: true });
  const path = NodePath.join(targetStateDir, "scient-extensions.json");
  if (capture.extensions === undefined) {
    NodeFS.rmSync(path, { force: true });
    return;
  }
  writeJsonAtomic(
    path,
    disownOutsideFolders(rebasePaths(capture.extensions, sourceDirs, targetDir), targetDir),
  );
}

/** Profiles the target lacks are added by id; its default stays unless it has none that resolves. */
function installClientSettings({ sourceStateDir, targetStateDir, firstStart }) {
  const source = readJsonObject(NodePath.join(sourceStateDir, "client-settings.json"));
  if (source === undefined) return;
  const targetPath = NodePath.join(targetStateDir, "client-settings.json");
  if (firstStart) {
    writeJsonAtomic(targetPath, source);
    return;
  }
  const target = readJsonObject(targetPath) ?? {};
  const profiles = Array.isArray(target.browserProfiles) ? [...target.browserProfiles] : [];
  const known = new Set(profiles.map((profile) => profile?.id));
  for (const profile of Array.isArray(source.browserProfiles) ? source.browserProfiles : []) {
    if (typeof profile?.id === "string" && !known.has(profile.id)) profiles.push(profile);
  }
  const next = { ...target, browserProfiles: profiles };
  const resolves = (id) =>
    id === DEFAULT_BROWSER_PROFILE_ID || profiles.some((profile) => profile?.id === id);
  if (!resolves(target.browserDefaultProfileId) && resolves(source.browserDefaultProfileId)) {
    next.browserDefaultProfileId = source.browserDefaultProfileId;
  }
  writeJsonAtomic(targetPath, next);
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
  const value = readText(NodePath.join(stateDir, "environment-id"))?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/** A new dev app gets its id now, so its website sign-ins can be placed before it first runs. */
function ensureEnvironmentId(stateDir) {
  const existing = readEnvironmentId(stateDir);
  if (existing !== undefined) return existing;
  NodeFS.mkdirSync(stateDir, { recursive: true });
  try {
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "environment-id"),
      `${NodeCrypto.randomUUID()}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return readEnvironmentId(stateDir);
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

/** A standalone, consistent copy of a cookie database, even while its app writes to it. */
async function backupDatabase(sourcePath, destinationPath) {
  NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const staged = `${destinationPath}.${process.pid}.staged`;
  NodeFS.rmSync(staged, { force: true });
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    await NodeSqlite.backup(source, staged);
  } finally {
    source.close();
  }
  NodeFS.chmodSync(staged, 0o600);
  return staged;
}

const cookieDatabase = (partitionDir) =>
  [NodePath.join(partitionDir, "Network", "Cookies"), NodePath.join(partitionDir, "Cookies")].find(
    exists,
  );

/**
 * Copies website sign-ins into profiles that have no cookies yet in the target. A profile the
 * target already signed into keeps its own.
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
    if (cookieDatabase(targetDir) !== undefined) continue;
    const to = NodePath.join(
      targetDir,
      NodePath.relative(NodePath.join(sourcePartitions, name), from),
    );
    const staged = await backupDatabase(from, to);
    try {
      if (decrypt) decryptCookieDatabase(staged, decrypt);
      NodeFS.renameSync(staged, to);
    } finally {
      NodeFS.rmSync(staged, { force: true });
    }
    copied.push(targetName);
  }
  return copied;
}

const homeStateDirs = (home) => {
  const checkout = readJsonObject(NodePath.join(home.root, HOME_RECORD))?.checkout;
  const dirs = [home.stateDir, realpathOrSelf(home.stateDir)];
  if (typeof checkout === "string")
    dirs.push(NodePath.join(checkout, ".scient-next", STATE_SUBDIR));
  return [...new Set(dirs)];
};

/** The path the home's own server uses for its state: through its checkout's link, if set up. */
const homeServerStateDir = (home) => {
  const checkout = readJsonObject(NodePath.join(home.root, HOME_RECORD))?.checkout;
  return typeof checkout === "string"
    ? NodePath.join(checkout, ".scient-next", STATE_SUBDIR)
    : home.stateDir;
};

/**
 * Copies the home's identity into a dev app that is about to start. Runs while no app of that
 * checkout is running; the home may be running, so its files are read as one snapshot.
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
  const capture = captureIdentity(home.stateDir);
  if (capture === undefined) return { status: "home-busy" };
  const firstStart =
    !exists(NodePath.join(targetStateDir, "settings.json")) &&
    !exists(NodePath.join(targetStateDir, "client-settings.json"));
  NodeFS.mkdirSync(targetStateDir, { recursive: true });
  const paths = { sourceDirs: homeStateDirs(home), targetDir: targetStateDir };

  const secrets = protection === "file" ? installSecrets({ capture, targetStateDir }) : [];
  installSettings({ capture, targetStateDir, ...paths, fullProfile: firstStart });
  installConnectors({ capture, targetStateDir, ...paths });
  installClientSettings({ sourceStateDir: home.stateDir, targetStateDir, firstStart });
  if (firstStart) {
    for (const path of PROFILE_PATHS) {
      const from = NodePath.join(home.stateDir, path);
      if (exists(from)) copyTree(from, NodePath.join(targetStateDir, path));
    }
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
          profileIds: browserProfileIds(NodePath.join(targetStateDir, "client-settings.json")),
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
    case "home-busy":
      return "The dev identity home kept changing while it was being copied; this dev app starts with the identity it already had. Restart it to try again.";
    case "disabled":
      return `${DEV_IDENTITY_ENV}=off: this dev app keeps its own accounts.`;
    default:
      return undefined;
  }
}

/** Chromium on macOS: AES-128-CBC under PBKDF2(Safe Storage secret); v24+ prefixes SHA-256(host). */
export function makeChromiumCookieDecrypter(safeStorageSecret) {
  const key = NodeCrypto.pbkdf2Sync(safeStorageSecret, "saltysalt", 1003, 16, "sha1");
  return (encrypted, { hostKey, hashPrefix }) => {
    if (encrypted.length === 0) return undefined;
    if (encrypted.subarray(0, 3).toString("latin1") !== "v10") return undefined;
    const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    if (!hashPrefix) return plain.toString("utf8");
    const expected = NodeCrypto.createHash("sha256").update(hostKey).digest();
    if (plain.length < 32 || !plain.subarray(0, 32).equals(expected)) return undefined;
    return plain.subarray(32).toString("utf8");
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
      .prepare(
        "SELECT rowid, host_key, encrypted_value FROM cookies WHERE length(encrypted_value) > 0",
      )
      .all();
    const update = database.prepare(
      "UPDATE cookies SET value = ?, encrypted_value = X'' WHERE rowid = ?",
    );
    const remove = database.prepare("DELETE FROM cookies WHERE rowid = ?");
    database.exec("BEGIN");
    for (const row of rows) {
      let value;
      try {
        value = decrypt(Buffer.from(row.encrypted_value), {
          hostKey: row.host_key,
          hashPrefix: version >= 24,
        });
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
    // Electron names the cookie key after the app; installs have used both of these names.
    cookieKeychains: [
      { service: "scient-next Safe Storage", account: "scient-next Key" },
      { service: "Scient Safe Storage", account: "Scient" },
    ],
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

/** The home's app writes its own files; seeding waits until it is closed. */
export function homeAppIsRunning(home = resolveDevIdentityHome(), isAlive = processIsAlive) {
  for (const file of ["electron.pid", "backend.pid"]) {
    const pid = Number.parseInt(
      readText(NodePath.join(home.root, "local-dev-app-runtime", file)) ?? "",
      10,
    );
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return true;
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
  if (!exists(installed.stateDir)) {
    throw new Error(`No installed Scient data at ${installed.stateDir}.`);
  }
  NodeFS.mkdirSync(home.stateDir, { recursive: true, mode: 0o700 });
  const report = { secrets: 0, websiteProfiles: 0, skipped: [] };

  const protection = vaultProtection(installed.stateDir);
  let sourceKey;
  if (protection === "file") {
    sourceKey = readBytes(NodePath.join(installed.stateDir, "secrets", `${VAULT_KEY_FILE}.bin`));
  } else if (protection === "keychain") {
    const encoded = await readKeychain("Scient Accounts", installed.vaultKeychainAccount);
    if (encoded) sourceKey = Buffer.from(encoded, "base64");
  }
  if (sourceKey !== undefined && sourceKey.length === 32) {
    vaultDecrypt(
      sourceKey,
      VAULT_SENTINEL,
      readBytes(NodePath.join(installed.stateDir, "secrets", `${VAULT_SENTINEL}.bin`)).subarray(1),
    );
  } else {
    sourceKey = undefined;
  }
  const capture = captureIdentity(installed.stateDir, { vaultKey: sourceKey });
  if (capture === undefined) {
    throw new Error(
      "The installed app kept changing its accounts while they were read; try again.",
    );
  }
  const homeDir = homeServerStateDir(home);
  const paths = { sourceDirs: [installed.stateDir], targetDir: homeDir };
  if (sourceKey === undefined) {
    capture.secrets = new Map(
      [...capture.secrets].filter(
        ([name, bytes]) => !name.startsWith("accounts-") && bytes[0] !== SEALED,
      ),
    );
    capture.accounts = undefined;
    report.skipped.push(
      "accounts and encrypted keys (the Keychain did not give the installed app's key)",
    );
  }
  const vault = makePortableVault();
  const unreadable = [];
  report.secrets = installSecrets({
    capture: { ...capture, secrets: withSourceKey(capture.secrets, sourceKey) },
    targetStateDir: home.stateDir,
    targetKey: vault.key,
    onSkip: (name) => unreadable.push(name),
  }).length;
  if (unreadable.length > 0) {
    report.skipped.push(`${String(unreadable.length)} saved secrets that could not be decrypted`);
  }
  installSettings({ capture, targetStateDir: home.stateDir, ...paths, fullProfile: true });
  installConnectors({ capture, targetStateDir: home.stateDir, ...paths });
  installClientSettings({
    sourceStateDir: installed.stateDir,
    targetStateDir: home.stateDir,
    firstStart: true,
  });
  for (const path of PROFILE_PATHS) {
    const from = NodePath.join(installed.stateDir, path);
    if (exists(from)) copyTree(from, NodePath.join(home.stateDir, path));
  }

  const installedEnvironmentId = readEnvironmentId(installed.stateDir);
  let cookieSecret = null;
  for (const item of installed.cookieKeychains) {
    cookieSecret = await readKeychain(item.service, item.account);
    if (cookieSecret) break;
  }
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

/** The capture keeps its source key beside the records so they can be re-encrypted. */
const withSourceKey = (secrets, sourceKey) => {
  const next = new Map(
    [...secrets].filter(
      ([name]) => name !== `${VAULT_KEY_FILE}.bin` && name !== `${VAULT_SENTINEL}.bin`,
    ),
  );
  if (sourceKey !== undefined) next.set(`${VAULT_KEY_FILE}.bin`, sourceKey);
  return next;
};

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
  if (NodePath.basename(checkout) !== HOME_CHECKOUT_NAME) {
    throw new Error(`The home checkout folder must be named ${HOME_CHECKOUT_NAME}.`);
  }
  NodeFS.mkdirSync(home.stateDir, { recursive: true, mode: 0o700 });
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
  writeJsonAtomic(NodePath.join(home.root, HOME_RECORD), { checkout });
  ensurePortableVault(home.stateDir);
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
          : NodePath.join(NodeOS.homedir(), HOME_CHECKOUT_NAME),
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
