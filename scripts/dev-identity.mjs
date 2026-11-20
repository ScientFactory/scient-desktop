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
const JOURNAL = "dev-identity-journal.json";
const HOME_RECORD = "dev-identity-home.json";
const HOME_LOCK = "dev-identity.lock";
const HOME_CHECKOUT_NAME = "scient-desktop-identity";
const STATE_SUBDIR = "scient-next-dev";
const PREVIEW_PARTITION_DIR_PREFIX = "scient-next-preview-";
const PROFILE_MARKER = "profile-";
const DEFAULT_BROWSER_PROFILE_ID = "default";
const VAULT_SENTINEL = "accounts-vault";
const VAULT_KEY_FILE = "accounts-master-key";
const ACCOUNTS_STATE = "accounts-state";
const SEALED = 0xff;
const SECRET_REDACTED = "••••••";
const CAPTURE_ATTEMPTS = 5;
const COOKIE_COPY_ATTEMPTS = 3;
const STAGED_SUFFIX = ".dev-identity-staged";
const OLD_SUFFIX = ".dev-identity-old";

/**
 * Secret records that are the owner's identity, never the install's. Each family is replaced as a
 * set. Left out: signing keys, cloud links, DPoP proofs, inbound `mcp-oauth-*`, managed Codex
 * sign-ins in `provider-auth-*` (Cursor's are added by name) and `accounts-sessions/`.
 */
const IDENTITY_SECRET =
  /^(?:accounts-(?:master-key|vault|state|activity)|accounts-value-[0-9a-f-]{36}|custom-model-.+|connector-.+|provider-env-.+|provider-config-.+|text-generator-.+|overleaf-git-token-.+|source-control-.+)\.bin$/u;
/** Records the vault encrypts directly; a connector record may still be legacy JSON. */
const VAULT_RECORD =
  /^(?:accounts-(?:state|activity)|accounts-value-[0-9a-f-]{36}|connector-[0-9a-f-]{36})$/u;
/** Install records the Accounts store seals with the vault key; they die with that key. */
const SEALED_INSTALL_RECORD = /^secret-request-[0-9a-f]{32}\.bin$/u;
/** A reference from settings, connectors or Accounts to a record that must travel with it. */
const RECORD_REFERENCE = /^(?:accounts-value|connector|custom-model)-[0-9a-f-]{36}$/u;

/** Server settings that describe the owner's models, providers and sign-ins; refreshed every start. */
export const IDENTITY_SETTINGS_KEYS = [
  "customModels",
  "providerInstances",
  "favorites",
  "providerModelPreferences",
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "textGenerators",
  "sourceControlHosts",
  "secretProviders",
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
const LOCAL_PROFILE_KEYS = ["send", "sharedWith", "received"];
/** Folders and files copied once, when a dev app starts for the first time. */
const PROFILE_PATHS = ["keybindings.json", "themes", "skills", "personal-skills.json"];
/** Folders under a state directory the copy writes into; none may be a link elsewhere. */
const WRITTEN_DIRS = ["secrets", "connectors", "electron-userdata", "electron-userdata/Partitions"];

/** A failure after the target started changing; the dev app must not start on it. */
export class DevIdentityFatalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DevIdentityFatalError";
    this.fatal = true;
  }
}

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

const isLink = (path) => {
  try {
    return NodeFS.lstatSync(path).isSymbolicLink();
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

const inside = (path, root) => path === root || path.startsWith(`${root}${NodePath.sep}`);

/** A missing file reads as absent; any other failure stops the copy instead of dropping data. */
const readBytes = (path) => {
  try {
    return NodeFS.readFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
};

const readText = (path) => readBytes(path)?.toString("utf8");

const parseJsonObject = (text) => {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const readJsonObject = (path) => {
  const text = readText(path);
  return text === undefined ? undefined : parseJsonObject(text);
};

const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Replace a file the way the app does: write beside it, then rename over it. */
function writeFileAtomic(path, data, mode = 0o600) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  NodeFS.writeFileSync(temporary, data, { mode, flag: "wx" });
  NodeFS.renameSync(temporary, path);
}

/** Moves one staged file or folder into place; safe to repeat after an interruption. */
function publish({ staged, path, tree }) {
  if (!exists(staged)) return;
  if (tree && exists(path)) {
    NodeFS.rmSync(`${path}${OLD_SUFFIX}`, { recursive: true, force: true });
    NodeFS.renameSync(path, `${path}${OLD_SUFFIX}`);
  }
  NodeFS.renameSync(staged, path);
  if (tree) NodeFS.rmSync(`${path}${OLD_SUFFIX}`, { recursive: true, force: true });
}

function applyJournal(journalPath, journal) {
  for (const write of journal.writes) publish(write);
  for (const path of journal.removals) NodeFS.rmSync(path, { recursive: true, force: true });
  NodeFS.rmSync(journalPath, { force: true });
}

/**
 * Finishes a copy that stopped after it began publishing. The journal is written only once every
 * replacement is staged, so finishing it always ends on the complete new set.
 */
export function recoverInterruptedCopy(stateDir) {
  const journalPath = NodePath.join(stateDir, JOURNAL);
  const journal = readJsonObject(journalPath);
  if (journal === undefined) {
    if (exists(journalPath)) {
      throw new DevIdentityFatalError(
        `${journalPath} is unreadable; this app's identity copy cannot be finished.`,
      );
    }
    return false;
  }
  try {
    applyJournal(journalPath, journal);
  } catch (error) {
    throw new DevIdentityFatalError(
      `Could not finish the interrupted identity copy in ${stateDir}.`,
      { cause: error },
    );
  }
  return true;
}

/**
 * Changes staged beside their targets. Nothing is published until every one is written; then a
 * journal records the set, so an interruption is finished on the next start.
 */
class StagedChanges {
  #writes = [];
  #removals = [];

  write(path, data, mode = 0o600) {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const staged = `${path}${STAGED_SUFFIX}`;
    NodeFS.rmSync(staged, { recursive: true, force: true });
    NodeFS.writeFileSync(staged, data, { mode, flag: "wx" });
    NodeFS.chmodSync(staged, mode);
    this.#writes.push({ staged, path });
  }

  copyTree(source, destination) {
    const staged = `${destination}${STAGED_SUFFIX}`;
    NodeFS.rmSync(staged, { recursive: true, force: true });
    NodeFS.cpSync(source, staged, { recursive: true, errorOnExist: true, force: false });
    this.#writes.push({ staged, path: destination, tree: true });
  }

  remove(path) {
    this.#removals.push(path);
  }

  commit(stateDir) {
    const journalPath = NodePath.join(stateDir, JOURNAL);
    const journal = { writes: this.#writes, removals: this.#removals };
    writeFileAtomic(journalPath, jsonBytes(journal));
    try {
      applyJournal(journalPath, journal);
    } catch (error) {
      throw new DevIdentityFatalError(`Could not finish the identity copy in ${stateDir}.`, {
        cause: error,
      });
    }
  }

  abort() {
    for (const { staged } of this.#writes) NodeFS.rmSync(staged, { recursive: true, force: true });
  }
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
  let names;
  try {
    names = NodeFS.readdirSync(secretsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => IDENTITY_SECRET.test(name) || providerAuth.has(name));
}

const base64url = (value) => Buffer.from(value, "utf8").toString("base64url");

/**
 * The slot each stored secret in settings lives in, named as `settingsSecrets.ts` names them. A
 * stored secret shows in settings as the redaction marker, alone or per server host.
 */
export function derivedSecretNames(settings) {
  const names = [];
  const fields = (group, slot) => {
    if (group === null || typeof group !== "object" || Array.isArray(group)) return;
    for (const [field, value] of Object.entries(group)) {
      if (value === SECRET_REDACTED) names.push(`${slot(field, null)}.bin`);
      else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [host, entry] of Object.entries(value)) {
          if (entry === SECRET_REDACTED) {
            names.push(`${slot(field, host.trim().toLowerCase())}.bin`);
          }
        }
      }
    }
  };
  const withHost = (base, host) => (host === null ? base : `${base}-${base64url(host)}`);
  for (const [id, instance] of Object.entries(settings?.providerInstances ?? {})) {
    const driver = typeof instance?.driver === "string" ? instance.driver : "";
    fields(instance?.config, (field, host) =>
      withHost(`provider-config-${base64url(id)}-${base64url(driver)}-${base64url(field)}`, host),
    );
    for (const variable of Array.isArray(instance?.environment) ? instance.environment : []) {
      if (typeof variable?.name !== "string") continue;
      if (variable.valueRedacted === true || variable.value === SECRET_REDACTED) {
        names.push(`provider-env-${base64url(id)}-${base64url(variable.name)}.bin`);
      }
    }
  }
  for (const [kind, group] of Object.entries(settings?.sourceControlHosts ?? {})) {
    fields(group, (field, host) =>
      withHost(`source-control-${base64url(kind)}-${base64url(field)}`, host),
    );
  }
  for (const [id, generator] of Object.entries(settings?.textGenerators ?? {})) {
    fields(generator, (field, host) =>
      withHost(`text-generator-${base64url(id)}-${base64url(field)}`, host),
    );
  }
  return names;
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

const makeSentinel = (key) =>
  Buffer.concat([Buffer.from([0]), vaultEncrypt(key, VAULT_SENTINEL, Buffer.alloc(0))]);

/** A fresh file-protected vault: the key file plus the sentinel the vault checks it against. */
export function makePortableVault() {
  const key = NodeCrypto.randomBytes(32);
  return { key, sentinel: makeSentinel(key) };
}

/** Gives a home without accounts a file key before its first launch would make a Keychain one. */
export function ensurePortableVault(stateDir) {
  if (vaultProtection(stateDir) !== "none") return false;
  const secrets = NodePath.join(stateDir, "secrets");
  if (exists(NodePath.join(secrets, `${ACCOUNTS_STATE}.bin`))) return false;
  const vault = makePortableVault();
  const changes = new StagedChanges();
  changes.write(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`), vault.key);
  changes.write(NodePath.join(secrets, `${VAULT_SENTINEL}.bin`), vault.sentinel);
  changes.commit(stateDir);
  return true;
}

/** Re-encrypts one identity record from the source vault key to the target vault key. */
export function reencryptSecret(name, bytes, sourceKey, targetKey) {
  const record = name.replace(/\.bin$/u, "");
  if (record === VAULT_SENTINEL || record === VAULT_KEY_FILE) return undefined;
  if (VAULT_RECORD.test(record)) {
    // A connector record from before the vault is plain JSON and moves as it is.
    if (bytes[0] !== 1 && record.startsWith("connector-")) return bytes;
    return vaultEncrypt(targetKey, record, vaultDecrypt(sourceKey, record, bytes));
  }
  if (bytes[0] === SEALED) {
    const value = vaultDecrypt(sourceKey, record, bytes.subarray(1));
    return Buffer.concat([Buffer.from([SEALED]), vaultEncrypt(targetKey, record, value)]);
  }
  return bytes;
}

/** The owner's accounts, without the senders, keys, choices and sharing of the source install. */
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
  if (Array.isArray(next.profiles)) {
    next.profiles = next.profiles.map((profile) => {
      if (profile === null || typeof profile !== "object") return profile;
      const copy = { ...profile };
      for (const key of LOCAL_PROFILE_KEYS) delete copy[key];
      return copy;
    });
  }
  return next;
}

/**
 * Reads one app's identity as a single consistent snapshot. Accounts and connectors write a value
 * before publishing its reference, so the snapshot is retaken until the anchors stayed the same
 * across the read and every reference resolves. A snapshot that never settles is refused.
 */
export function captureIdentity(
  stateDir,
  { vaultKey, attempts = CAPTURE_ATTEMPTS, afterRead = () => {} } = {},
) {
  const secretsDir = NodePath.join(stateDir, "secrets");
  const anchors = () =>
    [
      readBytes(NodePath.join(secretsDir, `${ACCOUNTS_STATE}.bin`)),
      readBytes(NodePath.join(secretsDir, `${VAULT_SENTINEL}.bin`)),
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
    if (
      (settingsText !== undefined && settings === undefined) ||
      (extensionsText !== undefined && extensions === undefined)
    ) {
      continue;
    }
    const secrets = new Map();
    for (const name of identitySecretNames(secretsDir, settings)) {
      const bytes = readBytes(NodePath.join(secretsDir, name));
      if (bytes !== undefined) secrets.set(name, bytes);
    }
    afterRead(attempt);
    if (before.join() !== anchors().join()) continue;
    const key = vaultKey ?? secrets.get(`${VAULT_KEY_FILE}.bin`);
    const sentinel = secrets.get(`${VAULT_SENTINEL}.bin`);
    let accounts;
    try {
      if (key !== undefined && sentinel !== undefined) {
        vaultDecrypt(key, VAULT_SENTINEL, sentinel.subarray(1));
      }
      const stateBlob = secrets.get(`${ACCOUNTS_STATE}.bin`);
      if (stateBlob !== undefined && key !== undefined) {
        accounts = JSON.parse(vaultDecrypt(key, ACCOUNTS_STATE, stateBlob).toString("utf8"));
      }
    } catch {
      continue;
    }
    const missing = [
      ...collectStrings([settings, extensions, accounts])
        .filter((text) => RECORD_REFERENCE.test(text))
        .map((reference) => `${reference}.bin`),
      ...derivedSecretNames(settings),
    ].filter((name) => !secrets.has(name));
    if (missing.length > 0) continue;
    return { stateDir, secrets, settings, extensions, accounts };
  }
  return undefined;
}

/**
 * Stages a captured identity's secrets for a target, re-encrypting each record when `targetKey` is
 * a new key; a record that cannot be re-encrypted stops the copy. The Accounts document is
 * rewritten without the source install's local state.
 */
function stageSecrets({ changes, capture, targetStateDir, targetKey }) {
  const targetSecrets = NodePath.join(targetStateDir, "secrets");
  NodeFS.mkdirSync(targetSecrets, { recursive: true, mode: 0o700 });
  const previousKey = readBytes(NodePath.join(targetSecrets, `${VAULT_KEY_FILE}.bin`));
  const sourceKey = capture.secrets.get(`${VAULT_KEY_FILE}.bin`) ?? targetKey;
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
      if (SEALED_INSTALL_RECORD.test(name)) removed.add(name);
    }
  }
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
    } catch (error) {
      throw new Error(`${name.replace(/\.bin$/u, "")} could not be decrypted.`, { cause: error });
    }
    if (output === undefined) continue;
    removed.delete(name);
    changes.write(NodePath.join(targetSecrets, name), output);
    written.push(name);
  }
  if (targetKey !== undefined) {
    for (const name of [`${VAULT_KEY_FILE}.bin`, `${VAULT_SENTINEL}.bin`]) removed.delete(name);
    changes.write(NodePath.join(targetSecrets, `${VAULT_KEY_FILE}.bin`), targetKey);
    changes.write(NodePath.join(targetSecrets, `${VAULT_SENTINEL}.bin`), makeSentinel(targetKey));
  }
  for (const name of removed) changes.remove(NodePath.join(targetSecrets, name));
  return written.filter(
    (name) => !name.startsWith(VAULT_SENTINEL) && !name.startsWith(VAULT_KEY_FILE),
  );
}

function stageSettings({ changes, capture, targetStateDir, sourceDirs, targetDir, fullProfile }) {
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
  changes.write(targetPath, jsonBytes(next));
}

function stageConnectors({ changes, capture, targetStateDir, sourceDirs, targetDir }) {
  const from = NodePath.join(capture.stateDir, "connectors");
  const to = NodePath.join(targetStateDir, "connectors");
  if (exists(from)) changes.copyTree(from, to);
  else changes.remove(to);
  // Undo history describes the connectors being replaced; it must not act on the copies.
  changes.remove(NodePath.join(targetStateDir, "connector-history"));
  const path = NodePath.join(targetStateDir, "scient-extensions.json");
  if (capture.extensions === undefined) {
    changes.remove(path);
    return;
  }
  changes.write(
    path,
    jsonBytes(
      disownOutsideFolders(rebasePaths(capture.extensions, sourceDirs, targetDir), targetDir),
    ),
  );
}

/** Profiles the target lacks are added by id; its default stays unless it has none that resolves. */
function stageClientSettings({ changes, sourceStateDir, targetStateDir, firstStart }) {
  const source = readJsonObject(NodePath.join(sourceStateDir, "client-settings.json"));
  if (source === undefined) return undefined;
  const targetPath = NodePath.join(targetStateDir, "client-settings.json");
  if (firstStart) {
    changes.write(targetPath, jsonBytes(source), 0o644);
    return source;
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
  changes.write(targetPath, jsonBytes(next), 0o644);
  return next;
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
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
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

const browserProfileIds = (clientSettings) => {
  const profiles = clientSettings?.browserProfiles;
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

/**
 * Where Chromium keeps a partition's cookie jar: under `Network/` once the checkpoint
 * `Network/NetworkDataMigrated` exists, at the partition root before that.
 */
export function cookieDatabasePath(partitionDir) {
  return exists(NodePath.join(partitionDir, "Network", "NetworkDataMigrated"))
    ? NodePath.join(partitionDir, "Network", "Cookies")
    : NodePath.join(partitionDir, "Cookies");
}

/**
 * A standalone, checked copy of a cookie jar. The jar and its journal are copied privately first,
 * so SQLite never creates files beside the source; a copy taken mid-write is taken again.
 */
async function snapshotCookieDatabase(sourcePath) {
  for (let attempt = 0; attempt < COOKIE_COPY_ATTEMPTS; attempt += 1) {
    const stagingDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dev-identity-cookies-"));
    try {
      const copy = NodePath.join(stagingDir, "Cookies.source");
      for (const suffix of ["", "-journal", "-wal"]) {
        const from = `${sourcePath}${suffix}`;
        if (exists(from)) NodeFS.copyFileSync(from, `${copy}${suffix}`);
      }
      const staged = NodePath.join(stagingDir, "Cookies");
      const source = new NodeSqlite.DatabaseSync(copy);
      try {
        await NodeSqlite.backup(source, staged);
      } finally {
        source.close();
      }
      const check = new NodeSqlite.DatabaseSync(staged, { readOnly: true });
      let healthy;
      try {
        healthy = check.prepare("PRAGMA quick_check").get()?.quick_check === "ok";
      } finally {
        check.close();
      }
      if (healthy) return { stagingDir, staged };
    } catch {
      // A jar caught mid-write; the next attempt copies it again.
    }
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
    sleep(100 * (attempt + 1));
  }
  return undefined;
}

/**
 * Stages website sign-ins for profiles that have no cookie jar yet in the target. A profile the
 * target already signed into keeps its own. Returns the profiles staged and those skipped.
 */
async function stageWebsiteSignIns({ changes, source, target, profileIds, decrypt }) {
  const sourcePartitions = NodePath.join(source.userData, "Partitions");
  let entries;
  try {
    entries = NodeFS.readdirSync(sourcePartitions).filter((name) =>
      name.startsWith(PREVIEW_PARTITION_DIR_PREFIX),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return { copied: [], skipped: [] };
    throw error;
  }
  const mapping = mapPreviewPartitions({
    sourceEnvironmentId: source.environmentId,
    targetEnvironmentId: target.environmentId,
    profileIds,
  });
  const copied = [];
  const skipped = [];
  for (const name of entries) {
    const from = cookieDatabasePath(NodePath.join(sourcePartitions, name));
    if (!exists(from)) continue;
    const targetName = mapping.get(name) ?? name;
    const targetDir = NodePath.join(target.userData, "Partitions", targetName);
    if (isLink(targetDir)) throw new Error(`${targetDir} is a link; nothing was copied into it.`);
    const to = cookieDatabasePath(targetDir);
    if (exists(to)) continue;
    const snapshot = await snapshotCookieDatabase(from);
    if (snapshot === undefined) {
      skipped.push(targetName);
      continue;
    }
    try {
      if (decrypt) decryptCookieDatabase(snapshot.staged, decrypt);
      changes.write(to, NodeFS.readFileSync(snapshot.staged));
    } finally {
      NodeFS.rmSync(snapshot.stagingDir, { recursive: true, force: true });
    }
    copied.push(targetName);
  }
  return { copied, skipped };
}

const homeCheckout = (home) => {
  const checkout = readJsonObject(NodePath.join(home.root, HOME_RECORD))?.checkout;
  return typeof checkout === "string" ? checkout : undefined;
};

const homeStateDirs = (home) => {
  const checkout = homeCheckout(home);
  const dirs = [home.stateDir, realpathOrSelf(home.stateDir)];
  if (checkout !== undefined) dirs.push(NodePath.join(checkout, ".scient-next", STATE_SUBDIR));
  return [...new Set(dirs)];
};

/** The path the home's own server uses for its state: through its checkout's link, if set up. */
const homeServerStateDir = (home) => {
  const checkout = homeCheckout(home);
  return checkout === undefined
    ? home.stateDir
    : NodePath.join(checkout, ".scient-next", STATE_SUBDIR);
};

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const lockOwner = (path) => {
  const pid = Number.parseInt(readText(path) ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

/** Whether a seed or setup holds the home now; the home app must not start under it. */
export function homeIsLocked(home = resolveDevIdentityHome(), isAlive = processIsAlive) {
  const pid = lockOwner(NodePath.join(home.root, HOME_LOCK));
  return pid !== undefined && isAlive(pid);
}

/**
 * Holds the home for one seed or setup. A dead owner's lock is set aside by renaming it, and only
 * if it still names that owner, so two processes cannot both take a stale lock.
 */
export function acquireHomeLock(home, isAlive = processIsAlive) {
  NodeFS.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  const path = NodePath.join(home.root, HOME_LOCK);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      NodeFS.writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => {
        if (lockOwner(path) === process.pid) NodeFS.rmSync(path, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = lockOwner(path);
      if (owner !== undefined && isAlive(owner)) {
        throw new Error("Another seed or setup is using the dev identity home.", { cause: error });
      }
      const aside = `${path}.stale-${process.pid}-${NodeCrypto.randomBytes(4).toString("hex")}`;
      try {
        NodeFS.renameSync(path, aside);
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
        continue;
      }
      // Another process may have replaced the stale lock just before the rename: put it back.
      const taken = lockOwner(aside);
      if (taken !== owner) {
        try {
          NodeFS.linkSync(aside, path);
        } catch {
          // The rightful owner's lock is gone; its holder finishes without it.
        }
      }
      NodeFS.rmSync(aside, { force: true });
    }
  }
  throw new Error("Could not lock the dev identity home.");
}

/** No folder the copy writes into may be a link that leads outside the target. */
function assertPlainTarget(stateDir) {
  const real = realpathOrSelf(stateDir);
  for (const relative of WRITTEN_DIRS) {
    const path = NodePath.join(stateDir, relative);
    if (isLink(path) || (exists(path) && !inside(realpathOrSelf(path), real))) {
      throw new DevIdentityFatalError(`${path} leads outside ${stateDir}; nothing was copied.`);
    }
  }
}

/** Whether a target path is, or lies inside, the home or the installed app's state. */
function isProtectedTarget(targetStateDir, home, installed) {
  const target = realpathOrSelf(targetStateDir);
  const parent = realpathOrSelf(NodePath.dirname(targetStateDir));
  const roots = [realpathOrSelf(home.root), realpathOrSelf(installed.stateDir)];
  return roots.some((root) => inside(target, root) || inside(parent, root) || inside(root, target));
}

const isHomeTarget = (targetStateDir, home) =>
  realpathOrSelf(NodePath.dirname(targetStateDir)) === realpathOrSelf(home.root) &&
  NodePath.basename(targetStateDir) === STATE_SUBDIR;

/**
 * Copies the home's identity into a dev app that is about to start. Runs while no app of that
 * checkout is running; the home may be running, so its files are read as one snapshot. Nothing
 * in the target changes until every replacement is staged, and an interrupted copy is finished.
 */
export async function importDevIdentity({
  targetStateDir,
  home = resolveDevIdentityHome(),
  installed = resolveInstalledApp(),
  environment = process.env,
  now = () => new Date(),
} = {}) {
  if (isHomeTarget(targetStateDir, home)) {
    if (homeIsLocked(home)) return { status: "home-seeding" };
    // A seed that stopped while publishing is finished before the home opens its vault.
    recoverInterruptedCopy(home.stateDir);
    return { status: "home" };
  }
  if (isProtectedTarget(targetStateDir, home, installed)) return { status: "refused-target" };
  assertPlainTarget(targetStateDir);
  recoverInterruptedCopy(targetStateDir);
  if (environment[DEV_IDENTITY_ENV] === "off") return { status: "disabled" };
  if (!exists(home.stateDir)) return { status: "no-home" };
  const protection = vaultProtection(home.stateDir);
  if (protection !== "file" && protection !== "none") {
    return { status: "home-vault-not-portable", protection };
  }
  if (homeIsLocked(home)) return { status: "home-busy" };
  const capture = captureIdentity(home.stateDir);
  if (capture === undefined) return { status: "home-busy" };
  const firstStart =
    !exists(NodePath.join(targetStateDir, "settings.json")) &&
    !exists(NodePath.join(targetStateDir, "client-settings.json"));
  NodeFS.mkdirSync(targetStateDir, { recursive: true, mode: 0o700 });
  const paths = { sourceDirs: homeStateDirs(home), targetDir: targetStateDir };

  const changes = new StagedChanges();
  let secrets = [];
  let websites = { copied: [], skipped: [] };
  try {
    if (protection === "file") secrets = stageSecrets({ changes, capture, targetStateDir });
    stageSettings({ changes, capture, targetStateDir, ...paths, fullProfile: firstStart });
    stageConnectors({ changes, capture, targetStateDir, ...paths });
    const clientSettings = stageClientSettings({
      changes,
      sourceStateDir: home.stateDir,
      targetStateDir,
      firstStart,
    });
    if (firstStart) {
      for (const path of PROFILE_PATHS) {
        const from = NodePath.join(home.stateDir, path);
        if (exists(from)) changes.copyTree(from, NodePath.join(targetStateDir, path));
      }
    }
    const homeEnvironmentId = readEnvironmentId(home.stateDir);
    if (homeEnvironmentId !== undefined) {
      websites = await stageWebsiteSignIns({
        changes,
        source: {
          userData: NodePath.join(home.stateDir, "electron-userdata"),
          environmentId: homeEnvironmentId,
        },
        target: {
          userData: NodePath.join(targetStateDir, "electron-userdata"),
          environmentId: ensureEnvironmentId(targetStateDir),
        },
        profileIds: browserProfileIds(
          clientSettings ?? readJsonObject(NodePath.join(targetStateDir, "client-settings.json")),
        ),
      });
    }
  } catch (error) {
    changes.abort();
    return {
      status: "copy-failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const summary = {
    status: "imported",
    importedAt: now().toISOString(),
    home: home.root,
    firstStart,
    secrets: secrets.length,
    websiteProfiles: websites.copied.length,
    websiteProfilesSkipped: websites.skipped.length,
  };
  changes.write(NodePath.join(targetStateDir, DEV_IDENTITY_MARKER), jsonBytes(summary), 0o644);
  changes.commit(targetStateDir);
  return summary;
}

export function describeImport(result) {
  switch (result.status) {
    case "imported":
      return `Copied your dev identity from ${result.home}: ${String(result.secrets)} saved secrets, settings and connectors${
        result.websiteProfiles > 0
          ? `, website sign-ins for ${String(result.websiteProfiles)} browser profile${result.websiteProfiles === 1 ? "" : "s"}`
          : ""
      }${
        result.websiteProfilesSkipped > 0
          ? ` (${String(result.websiteProfilesSkipped)} busy profile${result.websiteProfilesSkipped === 1 ? "" : "s"} left for next start)`
          : ""
      }.`;
    case "no-home":
      return "No dev identity home yet (pnpm dev:identity setup); this dev app starts with its own accounts.";
    case "home-vault-not-portable":
      return "The dev identity home keeps its accounts key in the Keychain, which other dev apps cannot open; run pnpm dev:identity seed to move it to a shared key. Starting with this app's own accounts.";
    case "home-busy":
      return "The dev identity home was changing while it was being copied; this dev app starts with the identity it already had. Restart it to try again.";
    case "copy-failed":
      return `Could not copy your dev identity (${result.reason}); this dev app starts with the identity it already had.`;
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

/** The home's state must be a real folder inside the home, apart from the installed app. */
function assertHomeLayout(home, installed) {
  const homeRoot = realpathOrSelf(home.root);
  const installedRoot = realpathOrSelf(installed.stateDir);
  if (inside(homeRoot, installedRoot) || inside(installedRoot, homeRoot)) {
    throw new Error("The installed app's data and the identity home overlap; nothing was copied.");
  }
  if (isLink(home.stateDir) || !inside(realpathOrSelf(home.stateDir), homeRoot)) {
    throw new Error(`${home.stateDir} leads outside ${home.root}; nothing was copied.`);
  }
  if (exists(home.stateDir)) assertPlainTarget(home.stateDir);
}

/**
 * Fills the home from the installed app. `readKeychain(service, account)` returns a secret string
 * or null; macOS asks the owner once for each item. The home changes only when the installed
 * app's accounts key was given and every record re-encrypted, all in one publication.
 */
export async function seedDevIdentityHome({
  home = resolveDevIdentityHome(),
  installed = resolveInstalledApp(),
  readKeychain,
  force = false,
  isRunning = homeAppIsRunning,
  isAlive = processIsAlive,
} = {}) {
  const release = acquireHomeLock(home, isAlive);
  try {
    if (isRunning(home)) {
      throw new Error("Quit Scient (Dev) · identity first (pnpm dev:app:stop in its checkout).");
    }
    if (!exists(installed.stateDir)) {
      throw new Error(`No installed Scient data at ${installed.stateDir}.`);
    }
    assertHomeLayout(home, installed);
    recoverInterruptedCopy(home.stateDir);
    const marker = readJsonObject(NodePath.join(home.stateDir, DEV_IDENTITY_MARKER));
    if (marker?.seededFrom !== undefined && !force) {
      throw new Error(
        `The dev identity home was already seeded on ${String(marker.seededAt)}. Pass --force to replace its accounts with the installed app's again.`,
      );
    }
    NodeFS.mkdirSync(home.stateDir, { recursive: true, mode: 0o700 });

    const protection = vaultProtection(installed.stateDir);
    let sourceKey;
    if (protection === "file") {
      sourceKey = readBytes(NodePath.join(installed.stateDir, "secrets", `${VAULT_KEY_FILE}.bin`));
    } else if (protection === "keychain") {
      const encoded = await readKeychain("Scient Accounts", installed.vaultKeychainAccount);
      if (encoded) sourceKey = Buffer.from(encoded, "base64");
    }
    if (protection !== "none" && sourceKey?.length !== 32) {
      throw new Error(
        "The Keychain did not give the installed app's accounts key, so nothing was copied. Run the seed again and click Allow.",
      );
    }
    const capture = captureIdentity(installed.stateDir, { vaultKey: sourceKey });
    if (capture === undefined) {
      throw new Error(
        "The installed app kept changing its accounts while they were read; try again.",
      );
    }
    let cookieSecret = null;
    for (const item of installed.cookieKeychains) {
      cookieSecret = await readKeychain(item.service, item.account);
      if (cookieSecret) break;
    }

    const report = { secrets: 0, websiteProfiles: 0, skipped: [] };
    const paths = { sourceDirs: [installed.stateDir], targetDir: homeServerStateDir(home) };
    const secrets = new Map(capture.secrets);
    if (sourceKey !== undefined) secrets.set(`${VAULT_KEY_FILE}.bin`, sourceKey);
    const changes = new StagedChanges();
    try {
      report.secrets = stageSecrets({
        changes,
        capture: { ...capture, secrets },
        targetStateDir: home.stateDir,
        targetKey: makePortableVault().key,
      }).length;
      stageSettings({
        changes,
        capture,
        targetStateDir: home.stateDir,
        ...paths,
        fullProfile: true,
      });
      stageConnectors({ changes, capture, targetStateDir: home.stateDir, ...paths });
      const clientSettings = stageClientSettings({
        changes,
        sourceStateDir: installed.stateDir,
        targetStateDir: home.stateDir,
        firstStart: true,
      });
      for (const path of PROFILE_PATHS) {
        const from = NodePath.join(installed.stateDir, path);
        if (exists(from)) changes.copyTree(from, NodePath.join(home.stateDir, path));
      }
      const installedEnvironmentId = readEnvironmentId(installed.stateDir);
      if (installedEnvironmentId !== undefined && cookieSecret) {
        const websites = await stageWebsiteSignIns({
          changes,
          source: { userData: installed.userData, environmentId: installedEnvironmentId },
          target: {
            userData: NodePath.join(home.stateDir, "electron-userdata"),
            environmentId: ensureEnvironmentId(home.stateDir),
          },
          profileIds: browserProfileIds(clientSettings),
          decrypt: makeChromiumCookieDecrypter(cookieSecret),
        });
        report.websiteProfiles = websites.copied.length;
        if (websites.skipped.length > 0) {
          report.skipped.push(
            `website sign-ins for ${String(websites.skipped.length)} profiles the installed app kept writing to`,
          );
        }
      } else {
        report.skipped.push("website sign-ins (the Keychain did not give the installed app's key)");
      }
      changes.write(
        NodePath.join(home.stateDir, DEV_IDENTITY_MARKER),
        jsonBytes({
          seededFrom: installed.stateDir,
          seededAt: new Date().toISOString(),
          secrets: report.secrets,
          websiteProfiles: report.websiteProfiles,
          skipped: report.skipped,
        }),
        0o644,
      );
    } catch (error) {
      changes.abort();
      throw error;
    }
    changes.commit(home.stateDir);
    return report;
  } finally {
    release();
  }
}

/**
 * Makes the checkout the home app runs from: a detached worktree of this clone, named so the app
 * is labelled "identity", at a commit that has this module. Its `.scient-next` points at the home,
 * so removing or recreating the checkout never loses the owner's accounts.
 */
export function setupHomeCheckout({
  repoRoot,
  checkout,
  ref = "origin/main",
  home = resolveDevIdentityHome(),
  run = (command, args, options) =>
    NodeChildProcess.execFileSync(command, args, { stdio: "inherit", ...options }),
  isAlive = processIsAlive,
}) {
  if (NodePath.basename(checkout) !== HOME_CHECKOUT_NAME) {
    throw new Error(`The home checkout folder must be named ${HOME_CHECKOUT_NAME}.`);
  }
  const link = NodePath.join(checkout, ".scient-next");
  if (exists(link)) {
    if (!isLink(link)) {
      throw new Error(
        `${link} already holds an app's data; move it aside before using this checkout.`,
      );
    }
    if (realpathOrSelf(link) !== realpathOrSelf(home.root)) {
      throw new Error(`${link} points somewhere other than ${home.root}.`);
    }
  }
  const release = acquireHomeLock(home, isAlive);
  try {
    NodeFS.mkdirSync(home.stateDir, { recursive: true, mode: 0o700 });
    if (!exists(checkout)) {
      if (ref === "origin/main") run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", "main"]);
      run("git", ["-C", repoRoot, "worktree", "add", "--detach", checkout, ref]);
    }
    if (!exists(NodePath.join(checkout, "scripts", "dev-identity.mjs"))) {
      throw new Error(
        `${checkout} is at a commit without the dev identity code; check out a newer commit there.`,
      );
    }
    if (!exists(link)) NodeFS.symlinkSync(home.root, link);
    writeFileAtomic(NodePath.join(home.root, HOME_RECORD), jsonBytes({ checkout }), 0o644);
    recoverInterruptedCopy(home.stateDir);
    ensurePortableVault(home.stateDir);
  } finally {
    release();
  }
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

const flagValue = (flags, name) => {
  const at = flags.indexOf(name);
  return at >= 0 ? flags[at + 1] : undefined;
};

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
      const checkout = NodePath.resolve(
        flagValue(flags, "--checkout") ?? NodePath.join(NodeOS.homedir(), HOME_CHECKOUT_NAME),
      );
      setupHomeCheckout({ repoRoot, checkout, ref: flagValue(flags, "--ref") ?? "origin/main" });
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
    throw new Error(
      "Usage: pnpm dev:identity setup [--checkout <path>] [--ref <commit>] | seed [--force] | status",
    );
  };
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
