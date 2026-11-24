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
/** Bumped whenever the lock, journal or vault handling changes; home and seed must agree. */
export const DEV_IDENTITY_PROTOCOL = 3;
export const DEV_IDENTITY_MARKER = "dev-identity.json";
const JOURNAL = "dev-identity-journal.json";
const HOME_RECORD = "dev-identity-home.json";
/** The seed lock: an exclusive SQLite transaction the OS drops with its process, however it ends. */
const HOME_LOCK = "dev-identity-lock.sqlite";
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
/** Private scratch inside a state directory; cookie jars are decrypted here, never in /tmp. */
const STAGING_DIR = "dev-identity-staging";
const OAUTH_GRANT_KIND = "oauth-connection";
/** A dev app's connectors whose sign-in it borrows from the home's own server. */
const CONNECTOR_BROKER = "dev-connector-broker.json";
const CONNECTOR_RECORD =
  /^connector-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/u;

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
/**
 * Records AccountsSecretStore seals with the vault key behind a 0xff byte: custom-model keys and
 * secret-request answers (not their plain salt). Other install records may start with 0xff too.
 */
const SEALED_RECORD = /^(?:custom-model-.+|secret-request-[0-9a-f]{32})$/u;
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
const WRITTEN_DIRS = [
  "secrets",
  "connectors",
  "electron-userdata",
  "electron-userdata/Partitions",
  STAGING_DIR,
];

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

/** The canonical path, also for a path that does not exist yet: its nearest existing parent. */
const realpathOrSelf = (path) => {
  const resolved = NodePath.resolve(path);
  try {
    return NodeFS.realpathSync(resolved);
  } catch {
    const parent = NodePath.dirname(resolved);
    return parent === resolved
      ? resolved
      : NodePath.join(realpathOrSelf(parent), NodePath.basename(resolved));
  }
};

/** The file's identity on disk; the same folder reached through a link or a case alias matches. */
const fileIdentity = (path) => {
  try {
    const stat = NodeFS.statSync(path);
    return `${String(stat.dev)}:${String(stat.ino)}`;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
};

const sameFile = (a, b) => {
  const identity = fileIdentity(a);
  return identity !== undefined && identity === fileIdentity(b);
};

/**
 * Whether `path`, existing or not, is `root` or lies inside it, judged by the folders on disk it
 * really sits in, so a link or a differently cased spelling of the same folder cannot slip past.
 */
function within(path, root) {
  const rootIdentity = fileIdentity(root);
  if (rootIdentity === undefined) return false;
  for (let current = realpathOrSelf(path); ;) {
    if (fileIdentity(current) === rootIdentity) return true;
    const parent = NodePath.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

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

/** Every path a copy touches must stay inside the state directory it was made for. */
function assertContained(root, paths) {
  for (const path of paths) {
    if (typeof path !== "string" || !within(NodePath.dirname(path), root)) {
      throw new Error(`${String(path)} leads outside ${root}; nothing was changed there.`);
    }
  }
}

function applyJournal(journalPath, journal) {
  const root = NodePath.dirname(journalPath);
  if (!Array.isArray(journal.writes) || !Array.isArray(journal.removals)) {
    throw new Error(`${journalPath} is not a dev identity journal.`);
  }
  // Checked before anything moves: a link planted since staging cannot redirect the replay.
  assertContained(root, [
    ...journal.writes.flatMap((write) => [write?.staged, write?.path]),
    ...journal.removals,
  ]);
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
  try {
    if (!exists(journalPath)) return false;
    const journal = readJsonObject(journalPath);
    if (journal === undefined) throw new Error(`${journalPath} is unreadable.`);
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
  #root;
  #writes = [];
  #removals = [];

  constructor(root) {
    this.#root = root;
  }

  write(path, data, mode = 0o600) {
    assertContained(this.#root, [path]);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const staged = `${path}${STAGED_SUFFIX}`;
    NodeFS.rmSync(staged, { recursive: true, force: true });
    NodeFS.writeFileSync(staged, data, { mode, flag: "wx" });
    NodeFS.chmodSync(staged, mode);
    this.#writes.push({ staged, path });
  }

  copyTree(source, destination) {
    assertContained(this.#root, [destination]);
    const staged = `${destination}${STAGED_SUFFIX}`;
    NodeFS.rmSync(staged, { recursive: true, force: true });
    NodeFS.cpSync(source, staged, { recursive: true, errorOnExist: true, force: false });
    this.#writes.push({ staged, path: destination, tree: true });
  }

  remove(path) {
    assertContained(this.#root, [path]);
    this.#removals.push(path);
  }

  commit() {
    const journalPath = NodePath.join(this.#root, JOURNAL);
    const journal = { writes: this.#writes, removals: this.#removals };
    writeFileAtomic(journalPath, jsonBytes(journal));
    try {
      applyJournal(journalPath, journal);
    } catch (error) {
      throw new DevIdentityFatalError(`Could not finish the identity copy in ${this.#root}.`, {
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

/**
 * Gives a home a file key before its first launch would make a Keychain one. A Keychain vault is
 * left as it is (the seed moves it); a file key whose sentinel is missing is kept and the
 * sentinel rebuilt from it; a vault holding any record no usable key opens is left untouched.
 */
export function ensurePortableVault(stateDir) {
  const protection = vaultProtection(stateDir);
  if (protection === "file" || protection === "keychain") return false;
  let target;
  try {
    target = readTargetVault(stateDir);
  } catch (error) {
    if (error instanceof TargetVaultError) return false;
    throw error;
  }
  const secrets = NodePath.join(stateDir, "secrets");
  const key = target.key ?? makePortableVault().key;
  const changes = new StagedChanges(stateDir);
  if (target.key === undefined) changes.write(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`), key);
  changes.write(NodePath.join(secrets, `${VAULT_SENTINEL}.bin`), makeSentinel(key));
  changes.commit();
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

/**
 * A connector record's envelope (AccountsConnectorCredentials): vault-sealed, or plain JSON from
 * before the vault. Undefined when it cannot be read; such a record is never copied.
 */
export function readConnectorEnvelope(name, bytes, key) {
  const record = name.replace(/\.bin$/u, "");
  try {
    const plain =
      bytes[0] === 123
        ? bytes
        : bytes[0] === 1 && key
          ? vaultDecrypt(key, record, bytes)
          : undefined;
    if (plain === undefined) return undefined;
    const envelope = JSON.parse(plain.toString("utf8"));
    return typeof envelope?.kind === "string" && typeof envelope.material === "string"
      ? envelope
      : undefined;
  } catch {
    return undefined;
  }
}

/** The OAuth material inside a sign-in envelope, or undefined when it is not one. */
const oauthMaterialOf = (envelope) => {
  if (envelope?.kind !== OAUTH_GRANT_KIND) return undefined;
  try {
    const material = JSON.parse(Buffer.from(envelope.material, "base64").toString("utf8"));
    return material?.format === 1 ? material : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A sign-in envelope with its grant and client registrations removed: refresh tokens rotate, so
 * only one app may hold them. The owner's own OAuth client stays, as it does not rotate.
 */
export function withoutOAuthGrant(envelope) {
  const material = oauthMaterialOf(envelope);
  if (material === undefined) return undefined;
  const kept = {
    format: 1,
    ...(material.ownClient === undefined ? {} : { ownClient: material.ownClient }),
    registrations: [],
  };
  return { ...envelope, material: Buffer.from(JSON.stringify(kept)).toString("base64") };
}

/** The grant id of a sign-in envelope, when it holds a grant. */
const grantIdOf = (envelope) => {
  const grantId = oauthMaterialOf(envelope)?.session?.grantId;
  return typeof grantId === "string" ? grantId : undefined;
};

const sealConnectorEnvelope = (name, envelope, key) => {
  const bytes = Buffer.from(JSON.stringify(envelope));
  return key === undefined ? bytes : vaultEncrypt(key, name.replace(/\.bin$/u, ""), bytes);
};

const oauthConnectorsOf = (extensions) =>
  Array.isArray(extensions?.connectors)
    ? extensions.connectors.filter(
        (connector) =>
          connector?.auth?.type === "oauth" && typeof connector.connectorId === "string",
      )
    : [];

/** The app whose sign-in a record holds, as the server records it at sign-in. */
const grantOwnerOf = (envelope) => {
  const material = oauthMaterialOf(envelope);
  return material?.session !== undefined &&
    typeof material.ownerEnvironmentId === "string" &&
    material.ownerEnvironmentId !== ""
    ? material.ownerEnvironmentId
    : undefined;
};

/**
 * The target's own connector sign-ins, which a copy keeps: a grant the target's server recorded
 * as its own, under a key that opens it. A copied grant names the app it came from.
 */
function ownOAuthGrants({ targetStateDir, targetKey, capture }) {
  const owned = new Map();
  const environmentId = readEnvironmentId(targetStateDir);
  if (targetKey === undefined || environmentId === undefined) return owned;
  const sourceById = new Map(
    oauthConnectorsOf(capture.extensions).map((connector) => [connector.connectorId, connector]),
  );
  const targetExtensions = readJsonObject(NodePath.join(targetStateDir, "scient-extensions.json"));
  for (const connector of oauthConnectorsOf(targetExtensions)) {
    const ref = connector.auth.credentialRef;
    const source = sourceById.get(connector.connectorId);
    if (typeof ref !== "string" || source === undefined || source.url !== connector.url) continue;
    const name = `${ref}.bin`;
    if (!CONNECTOR_RECORD.test(name)) continue;
    const bytes = readBytes(NodePath.join(targetStateDir, "secrets", name));
    if (bytes === undefined) continue;
    if (grantOwnerOf(readConnectorEnvelope(name, bytes, targetKey)) !== environmentId) continue;
    owned.set(connector.connectorId, { name, connector });
  }
  return owned;
}

/** The home's signed-in OAuth connectors, which a dev app borrows instead of copying. */
function borrowableOAuthConnectors({ capture, sourceKey, owned }) {
  const borrowed = new Map();
  for (const connector of oauthConnectorsOf(capture.extensions)) {
    if (connector.status !== "connected" || owned.has(connector.connectorId)) continue;
    const ref = connector.auth.credentialRef;
    const name = typeof ref === "string" ? `${ref}.bin` : undefined;
    const bytes = name === undefined ? undefined : capture.secrets.get(name);
    if (
      bytes === undefined ||
      grantIdOf(readConnectorEnvelope(name, bytes, sourceKey)) === undefined
    ) {
      continue;
    }
    if (typeof connector.url === "string")
      borrowed.set(connector.connectorId, { url: connector.url });
  }
  return borrowed;
}

/**
 * Connector states for the target: a sign-in it made stays as it is; every other OAuth connector
 * waits for its own sign-in, keeping a reference only to a record the copy wrote.
 */
function connectorStatesFor({ extensions, owned, written, borrowed = new Set() }) {
  if (!Array.isArray(extensions?.connectors)) return extensions;
  return {
    ...extensions,
    connectors: extensions.connectors.map((connector) => {
      if (connector?.auth?.type !== "oauth") return connector;
      const own = owned.get(connector.connectorId);
      if (own !== undefined) {
        return {
          ...connector,
          auth: own.connector.auth,
          status: own.connector.status,
          authRevision: own.connector.authRevision ?? connector.authRevision,
          ...(own.connector.lastError === undefined
            ? { lastError: undefined }
            : { lastError: own.connector.lastError }),
        };
      }
      const { credentialRef, ...auth } = connector.auth;
      const keepsRef = typeof credentialRef === "string" && written.has(`${credentialRef}.bin`);
      return {
        ...connector,
        auth: keepsRef ? { ...auth, credentialRef } : auth,
        status:
          connector.status === "connected" && !borrowed.has(connector.connectorId)
            ? "needs-auth"
            : connector.status,
        lastError: undefined,
      };
    }),
  };
}

/**
 * Retires connector grants a dev app holds but did not sign in itself, which only a copy from
 * the home or the installed app could have left: removed here only, never revoked, since the app
 * it came from may still hold it. A profile that never took a copy, or a record no key here
 * opens, is left as it is.
 */
export function retireCopiedOAuthGrants(stateDir, { isRunning = () => false } = {}) {
  if (!exists(NodePath.join(stateDir, DEV_IDENTITY_MARKER))) return false;
  const secrets = NodePath.join(stateDir, "secrets");
  const extensionsPath = NodePath.join(stateDir, "scient-extensions.json");
  const extensions = readJsonObject(extensionsPath);
  const key = readBytes(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`));
  const usableKey = key?.length === 32 ? key : undefined;
  const environmentId = readEnvironmentId(stateDir);
  const retired = [];
  for (const connector of oauthConnectorsOf(extensions)) {
    const ref = connector.auth.credentialRef;
    const name = typeof ref === "string" ? `${ref}.bin` : undefined;
    if (name === undefined || !CONNECTOR_RECORD.test(name)) continue;
    const bytes = readBytes(NodePath.join(secrets, name));
    const envelope =
      bytes === undefined ? undefined : readConnectorEnvelope(name, bytes, usableKey);
    const material = oauthMaterialOf(envelope);
    // Its own only when both ids exist and match; two missing ids prove nothing.
    if (
      material?.session === undefined ||
      (environmentId !== undefined && grantOwnerOf(envelope) === environmentId)
    ) {
      continue;
    }
    const stripped = withoutOAuthGrant(envelope);
    if (stripped !== undefined)
      retired.push({ name, bytes, stripped, connectorId: connector.connectorId });
  }
  if (retired.length === 0 || isRunning()) return false;
  const changes = new StagedChanges(stateDir);
  try {
    for (const { name, bytes, stripped } of retired) {
      changes.write(
        NodePath.join(secrets, name),
        sealConnectorEnvelope(name, stripped, bytes[0] === 1 ? usableKey : undefined),
      );
    }
    const retiredIds = new Set(retired.map((entry) => entry.connectorId));
    changes.write(
      extensionsPath,
      jsonBytes({
        ...extensions,
        connectors: extensions.connectors.map((connector) =>
          retiredIds.has(connector?.connectorId) && connector.status === "connected"
            ? { ...connector, status: "needs-auth", lastError: undefined }
            : connector,
        ),
      }),
    );
  } catch (error) {
    changes.abort();
    throw error;
  }
  changes.commit();
  return true;
}

/**
 * A dev app started with its own accounts only: it stops borrowing the home's sign-ins, and the
 * connectors it borrowed wait for a sign-in of its own.
 */
export function stopBorrowing(stateDir) {
  const bindingPath = NodePath.join(stateDir, CONNECTOR_BROKER);
  const binding = readJsonObject(bindingPath);
  if (binding === undefined) return false;
  const borrowed = new Set(Object.keys(binding.connectors ?? {}));
  const secrets = NodePath.join(stateDir, "secrets");
  const key = readBytes(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`));
  const extensionsPath = NodePath.join(stateDir, "scient-extensions.json");
  const extensions = readJsonObject(extensionsPath);
  const hasOwnGrant = (connector) => {
    const ref = connector.auth.credentialRef;
    const name = typeof ref === "string" ? `${ref}.bin` : undefined;
    const bytes = name === undefined ? undefined : readBytes(NodePath.join(secrets, name));
    return (
      bytes !== undefined &&
      oauthMaterialOf(readConnectorEnvelope(name, bytes, key?.length === 32 ? key : undefined))
        ?.session !== undefined
    );
  };
  const changes = new StagedChanges(stateDir);
  if (Array.isArray(extensions?.connectors)) {
    changes.write(
      extensionsPath,
      jsonBytes({
        ...extensions,
        connectors: extensions.connectors.map((connector) =>
          connector?.auth?.type === "oauth" &&
          borrowed.has(connector.connectorId) &&
          connector.status === "connected" &&
          !hasOwnGrant(connector)
            ? { ...connector, status: "needs-auth", lastError: undefined }
            : connector,
        ),
      }),
    );
  }
  changes.remove(bindingPath);
  changes.commit();
  return true;
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

const accountIdOf = (account) => account?.summary?.accountId;
const profileIdOf = (profile) => profile?.profileId;

/** `emptyState` in AccountPersistence.ts: the Accounts document of an app with no accounts. */
const EMPTY_ACCOUNTS = {
  format: 1,
  agentAccess: true,
  accounts: [],
  profiles: [],
  onePasswordStatus: { state: "not-connected" },
};

/**
 * The owner's accounts copied over a target, keeping what belongs to the target itself: its
 * senders, sender keys and per-thread profile choices, each profile's sharing records, the whole
 * row of any account with copies still waiting for the target's password stores, and the whole
 * row of any browser profile only the target has, so its controls are not reset to the defaults.
 */
export function keepLocalAccounts(next, local) {
  if (local === null || typeof local !== "object") return next;
  const merged = { ...next };
  for (const key of LOCAL_ACCOUNTS_KEYS) {
    if (Object.hasOwn(local, key)) merged[key] = local[key];
  }
  const keep = (items, localItems, idOf, keys) => {
    if (!Array.isArray(localItems)) return items;
    const list = Array.isArray(items) ? items : [];
    const own = new Map(
      localItems
        .filter((item) => item !== null && typeof item === "object" && idOf(item) !== undefined)
        .map((item) => [idOf(item), item]),
    );
    return list.map((item) => {
      const mine = idOf(item) === undefined ? undefined : own.get(idOf(item));
      if (mine === undefined) return item;
      const copy = { ...item };
      for (const key of keys) if (Object.hasOwn(mine, key)) copy[key] = mine[key];
      return copy;
    });
  };
  const pending = pendingAccounts(local);
  if (pending.length > 0) {
    const list = Array.isArray(merged.accounts) ? merged.accounts : [];
    const mine = new Map(pending.map((account) => [accountIdOf(account), account]));
    const listed = new Set(list.map(accountIdOf));
    merged.accounts = [
      ...list.map((account) => mine.get(accountIdOf(account)) ?? account),
      ...pending.filter((account) => !listed.has(accountIdOf(account))),
    ];
  }
  merged.profiles = keep(merged.profiles, local.profiles, profileIdOf, LOCAL_PROFILE_KEYS);
  if (Array.isArray(local.profiles)) {
    const present = new Set((merged.profiles ?? []).map(profileIdOf));
    merged.profiles = [
      ...(merged.profiles ?? []),
      ...local.profiles.filter(
        (profile) => profileIdOf(profile) !== undefined && !present.has(profileIdOf(profile)),
      ),
    ];
  }
  return merged;
}

const hasPendingCopies = (account) =>
  account?.pendingCopies !== null &&
  typeof account?.pendingCopies === "object" &&
  Object.values(account.pendingCopies).some((stores) => Array.isArray(stores) && stores.length > 0);

/**
 * A target's accounts with copies still waiting for its password stores. Such an account may hold
 * the only copy of a value the owner changed there, so it stays the target's, records and all,
 * until those copies are written.
 */
const pendingAccounts = (local) =>
  Array.isArray(local?.accounts)
    ? local.accounts.filter(
        (account) => accountIdOf(account) !== undefined && hasPendingCopies(account),
      )
    : [];

/** The value records a target's pending accounts point at, kept as the target has them. */
const pendingRecords = (local) =>
  new Set(
    collectStrings(pendingAccounts(local))
      .filter((text) => RECORD_REFERENCE.test(text))
      .map((reference) => `${reference}.bin`),
  );

/** A target whose own accounts would be lost by the copy; it keeps the identity it has. */
class TargetVaultError extends Error {}

/** Every record sealed under a vault key, other than the key and its sentinel. */
function vaultSealedNames(secretsDir) {
  let names;
  try {
    names = NodeFS.readdirSync(secretsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => {
    const record = name.replace(/\.bin$/u, "");
    if (record === name || record === VAULT_SENTINEL || record === VAULT_KEY_FILE) return false;
    const path = NodePath.join(secretsDir, name);
    if (!NodeFS.lstatSync(path).isFile()) return false;
    const first = readBytes(path)?.[0];
    // A connector record from before the vault is plain JSON and needs no key.
    if (VAULT_RECORD.test(record)) return !(record.startsWith("connector-") && first !== 1);
    return first === SEALED && SEALED_RECORD.test(record);
  });
}

/** Records a copy replaces from the home; the Accounts document keeps the target's own part. */
const replacedByCopy = (name) => name !== `${ACCOUNTS_STATE}.bin` && IDENTITY_SECRET.test(name);

/**
 * The target's own vault: its key and Accounts document when a file key opens them. A file key
 * whose sentinel is missing is kept too: the app rebuilds the sentinel from it. A Keychain,
 * unreadable or keyless vault is replaced only when no sealed record but those `replaced`
 * names would be lost with it.
 */
function readTargetVault(stateDir, { replaced = () => false } = {}) {
  const secrets = NodePath.join(stateDir, "secrets");
  const ownData = vaultSealedNames(secrets).some((name) => !replaced(name));
  const protection = vaultProtection(stateDir);
  const key = readBytes(NodePath.join(secrets, `${VAULT_KEY_FILE}.bin`));
  if (protection === "file" || (protection === "none" && key !== undefined)) {
    try {
      if (key?.length !== 32) throw new Error("no usable key");
      const sentinel = readBytes(NodePath.join(secrets, `${VAULT_SENTINEL}.bin`));
      if (sentinel !== undefined) vaultDecrypt(key, VAULT_SENTINEL, sentinel.subarray(1));
      const blob = readBytes(NodePath.join(secrets, `${ACCOUNTS_STATE}.bin`));
      const accounts =
        blob === undefined
          ? undefined
          : JSON.parse(vaultDecrypt(key, ACCOUNTS_STATE, blob).toString("utf8"));
      return { key, accounts, sentinel: sentinel !== undefined };
    } catch (error) {
      if (!ownData) return {};
      throw new TargetVaultError("its accounts key does not open its own accounts", {
        cause: error,
      });
    }
  }
  if (ownData) {
    throw new TargetVaultError(
      protection === "keychain"
        ? "its accounts key is in the Keychain, and replacing it would lose this app's own accounts data"
        : "its accounts data has no key here to open it, and replacing it would lose that data",
    );
  }
  return {};
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
 * Stages a captured identity's secrets for a target under the target's own vault key, or a new
 * file key when it has none; a record that cannot be re-encrypted stops the copy. The target's
 * other records sealed under its key stay, and so does its own part of the Accounts document.
 */
function stageSecrets({
  changes,
  capture,
  sourceKey,
  targetStateDir,
  target,
  ownGrants = new Map(),
}) {
  const targetSecrets = NodePath.join(targetStateDir, "secrets");
  NodeFS.mkdirSync(targetSecrets, { recursive: true, mode: 0o700 });
  const key = target.key ?? makePortableVault().key;
  const removed = new Set(
    identitySecretNames(
      targetSecrets,
      readJsonObject(NodePath.join(targetStateDir, "settings.json")),
    ),
  );
  for (const name of [`${VAULT_KEY_FILE}.bin`, `${VAULT_SENTINEL}.bin`]) removed.delete(name);
  const kept = pendingRecords(target.accounts);
  for (const { name } of ownGrants.values()) kept.add(name);
  for (const name of kept) removed.delete(name);
  const sealAccounts = (accounts) =>
    vaultEncrypt(
      key,
      ACCOUNTS_STATE,
      Buffer.from(JSON.stringify(keepLocalAccounts(accounts, target.accounts))),
    );
  const written = [];
  for (const [name, bytes] of capture.secrets) {
    if (kept.has(name)) continue;
    let output;
    try {
      if (CONNECTOR_RECORD.test(name)) {
        // Only records positively read as connector credentials travel, and a sign-in only
        // without its grant.
        const envelope = readConnectorEnvelope(name, bytes, sourceKey ?? key);
        if (envelope === undefined) continue;
        output =
          envelope.kind === OAUTH_GRANT_KIND
            ? (() => {
                const stripped = withoutOAuthGrant(envelope);
                return stripped === undefined
                  ? undefined
                  : sealConnectorEnvelope(name, stripped, key);
              })()
            : sealConnectorEnvelope(name, envelope, key);
      } else {
        output =
          name === `${ACCOUNTS_STATE}.bin` && capture.accounts !== undefined
            ? sealAccounts(scrubAccountsState(capture.accounts))
            : reencryptSecret(name, bytes, sourceKey ?? key, key);
      }
    } catch (error) {
      throw new Error(`${name.replace(/\.bin$/u, "")} could not be decrypted.`, { cause: error });
    }
    if (output === undefined) continue;
    removed.delete(name);
    changes.write(NodePath.join(targetSecrets, name), output);
    written.push(name);
  }
  // A home without an Accounts document yet still leaves the target its own part of one.
  if (!capture.secrets.has(`${ACCOUNTS_STATE}.bin`) && target.accounts !== undefined) {
    removed.delete(`${ACCOUNTS_STATE}.bin`);
    changes.write(
      NodePath.join(targetSecrets, `${ACCOUNTS_STATE}.bin`),
      sealAccounts(EMPTY_ACCOUNTS),
    );
  }
  if (target.key === undefined) {
    changes.write(NodePath.join(targetSecrets, `${VAULT_KEY_FILE}.bin`), key);
  }
  if (!target.sentinel) {
    changes.write(NodePath.join(targetSecrets, `${VAULT_SENTINEL}.bin`), makeSentinel(key));
  }
  for (const name of removed) changes.remove(NodePath.join(targetSecrets, name));
  return written;
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

function stageConnectors({
  changes,
  capture,
  targetStateDir,
  sourceDirs,
  targetDir,
  ownGrants = new Map(),
  written = new Set(),
  borrowed = new Map(),
  homeStateDir,
}) {
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
  const extensions = connectorStatesFor({
    extensions: capture.extensions,
    owned: ownGrants,
    written,
    borrowed: new Set(borrowed.keys()),
  });
  const bindingPath = NodePath.join(targetStateDir, CONNECTOR_BROKER);
  if (borrowed.size > 0 && homeStateDir !== undefined) {
    changes.write(
      bindingPath,
      jsonBytes({ version: 1, homeStateDir, connectors: Object.fromEntries(borrowed) }),
    );
  } else if (exists(bindingPath)) {
    changes.remove(bindingPath);
  }
  changes.write(
    path,
    jsonBytes(disownOutsideFolders(rebasePaths(extensions, sourceDirs, targetDir), targetDir)),
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
 * A standalone, checked copy of a cookie jar, made in the destination's private staging folder:
 * the jar may hold plain values, so it never sits outside the dev state folders. The jar and its
 * journal are copied first, so SQLite never creates files beside the source; a copy taken
 * mid-write is taken again.
 */
async function snapshotCookieDatabase(sourcePath, stagingRoot) {
  NodeFS.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < COOKIE_COPY_ATTEMPTS; attempt += 1) {
    const stagingDir = NodeFS.mkdtempSync(NodePath.join(stagingRoot, "cookies-"));
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
  const targetStateDir = NodePath.dirname(target.userData);
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
    const jarParent = NodePath.dirname(to);
    if (isLink(jarParent) || !within(jarParent, targetStateDir)) {
      throw new Error(`${jarParent} leads outside this app's data; nothing was copied into it.`);
    }
    const snapshot = await snapshotCookieDatabase(from, NodePath.join(targetStateDir, STAGING_DIR));
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

const openHomeLock = (home, timeout) => {
  NodeFS.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  return new NodeSqlite.DatabaseSync(NodePath.join(home.root, HOME_LOCK), { timeout });
};

const isBusy = (error) => /database is locked|SQLITE_BUSY/u.test(String(error?.message ?? error));

/** Whether a seed or setup holds the home now; the home app must not start under it. */
export function homeIsLocked(home = resolveDevIdentityHome()) {
  if (!exists(NodePath.join(home.root, HOME_LOCK))) return false;
  const database = openHomeLock(home, 0);
  try {
    // A shared read: refused while a seed holds the lock, never in the way of another check.
    database.exec("BEGIN");
    database.prepare("SELECT count(*) FROM sqlite_master").get();
    database.exec("ROLLBACK");
    return false;
  } catch (error) {
    if (isBusy(error)) return true;
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Holds the home for one seed or setup. The lock lives as long as this process holds it open, so
 * a seed that dies frees it at once and no stale lock is ever cleared by hand.
 */
export function acquireHomeLock(home) {
  // Waits out a brief check by another process, never a seed.
  const database = openHomeLock(home, 2_000);
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (isBusy(error)) {
      throw new Error("Another seed or setup is using the dev identity home.", { cause: error });
    }
    throw error;
  }
  return () => {
    database.exec("ROLLBACK");
    database.close();
  };
}

/** No folder the copy writes into may be a link that leads outside the target. */
function assertPlainTarget(stateDir) {
  for (const relative of WRITTEN_DIRS) {
    const path = NodePath.join(stateDir, relative);
    if (isLink(path) || (exists(path) && !within(path, stateDir))) {
      throw new DevIdentityFatalError(`${path} leads outside ${stateDir}; nothing was copied.`);
    }
  }
}

/** Whether a target path is, or lies inside, or holds, the home or the installed app's state. */
function isProtectedTarget(targetStateDir, home, installed) {
  return [home.root, installed.stateDir].some(
    (root) =>
      within(targetStateDir, root) ||
      within(NodePath.dirname(targetStateDir), root) ||
      within(root, targetStateDir),
  );
}

const isHomeTarget = (targetStateDir, home) =>
  sameFile(NodePath.dirname(targetStateDir), home.root) &&
  NodePath.basename(targetStateDir) === STATE_SUBDIR;

/**
 * A checkout whose app data, or the state folder inside it, is or lies in the identity home must
 * be the checkout the home was set up with; any other would run a second app on the home's vault
 * and databases. Called before the launcher touches the checkout's runner or app state.
 */
export function assertHomeCheckout({ checkoutRoot, stateRoot, home = resolveDevIdentityHome() }) {
  if (!within(stateRoot, home.root) && !within(NodePath.join(stateRoot, STATE_SUBDIR), home.root)) {
    return;
  }
  const registered = homeCheckout(home);
  if (
    sameFile(stateRoot, home.root) &&
    registered !== undefined &&
    sameFile(checkoutRoot, registered)
  ) {
    return;
  }
  throw new Error(
    `${stateRoot} leads into the dev identity home's data, which only its own checkout (${
      registered ?? "none yet; run pnpm dev:identity setup"
    }) may run. Remove that link from ${checkoutRoot} before starting it.`,
  );
}

/**
 * Readies an app about to open `stateRoot`: "not-home" for any app but the home's own; for the
 * home, "seeding" while a seed or setup holds it, else "ready" once the home's layout is checked
 * and a seed that stopped while publishing is finished. Every way of starting an app calls it.
 */
export function prepareHomeStart({
  checkoutRoot,
  stateRoot,
  home = resolveDevIdentityHome(),
  installed = resolveInstalledApp(),
}) {
  assertHomeCheckout({ checkoutRoot, stateRoot, home });
  if (!sameFile(stateRoot, home.root)) return "not-home";
  if (homeIsLocked(home)) return "seeding";
  assertHomeLayout(home, installed);
  recoverInterruptedCopy(home.stateDir);
  clearStaging(home.stateDir);
  // A home seeded by an earlier version holds copies of the installed app's sign-ins.
  retireCopiedOAuthGrants(home.stateDir, {
    // This start's own runner receipt is not another app.
    isRunning: () => homeAppIsRunning(home, (pid) => pid !== process.pid && processIsAlive(pid)),
  });
  return "ready";
}

const RUNNERS_DIR = "dev-identity-runners";
/** The launcher's own grace for a runner folder whose receipt is not written yet. */
const RUNNER_START_GRACE_MS = 5_000;

/**
 * Claims the state a runner opens. Another app: finish its stopped copy first. The home: record the
 * runner before checking the seed lock (a seed locks before checking runners), held while the runner
 * or any `holdGroup` group lives, until `release`.
 */
export function claimHomeStart({
  checkoutRoot,
  stateRoot,
  home = resolveDevIdentityHome(),
  installed = resolveInstalledApp(),
  pid = process.pid,
  environment = process.env,
  // eslint-disable-next-line t3code/no-global-process-runtime -- The launcher runs before any app runtime exists.
  platform = NodeOS.platform(),
}) {
  assertHomeCheckout({ checkoutRoot, stateRoot, home });
  if (!sameFile(stateRoot, home.root)) {
    const stateDir = NodePath.join(stateRoot, STATE_SUBDIR);
    if (!isProtectedTarget(stateDir, home, installed)) {
      assertPlainTarget(stateDir);
      const releaseState = lockStateDir(stateDir);
      try {
        recoverInterruptedCopy(stateDir);
        clearStaging(stateDir);
        // A second start of an app that already runs must not rewrite its connectors under it.
        // Asked only when something would change; without lsof (Windows) it counts as running.
        const running = () => platform === "win32" || processesUsingState(stateDir).length > 0;
        retireCopiedOAuthGrants(stateDir, { isRunning: running });
        if (
          environment[DEV_IDENTITY_ENV] === "off" &&
          exists(NodePath.join(stateDir, CONNECTOR_BROKER)) &&
          !running()
        ) {
          stopBorrowing(stateDir);
        }
      } finally {
        releaseState();
      }
    }
    return { status: "not-home", release: () => {}, holdGroup: () => {} };
  }
  const receipt = NodePath.join(home.root, RUNNERS_DIR, `${String(pid)}.json`);
  const groups = [];
  const record = () => writeFileAtomic(receipt, jsonBytes({ pid, processGroups: groups }));
  record();
  const release = () => NodeFS.rmSync(receipt, { force: true });
  let readiness;
  try {
    readiness = prepareHomeStart({ checkoutRoot, stateRoot, home, installed });
  } catch (error) {
    release();
    throw error;
  }
  if (readiness === "seeding") {
    release();
    return { status: "seeding", release: () => {}, holdGroup: () => {} };
  }
  const holdGroup = (group) => {
    if (!Number.isInteger(group) || group <= 1) return;
    groups.push(group);
    record();
  };
  return { status: "ready", release, holdGroup };
}

/**
 * Processes other than this one with a file open directly in the home's state or browser data:
 * an app's databases, however it was started and whatever started it.
 */
const processesUsingHome = (home) => processesUsingState(home.stateDir);

/** Processes other than this one with a file open in an app's state or browser data. */
const processesUsingState = (stateDir) => {
  const dirs = [stateDir, NodePath.join(stateDir, "electron-userdata")].filter(exists);
  if (dirs.length === 0) return [];
  const result = NodeChildProcess.spawnSync("lsof", ["-t", ...dirs.flatMap((dir) => ["+d", dir])], {
    encoding: "utf8",
  });
  // lsof exits 1 when nothing is open; anything else without output means it could not look.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error("Could not check which processes use the dev identity home (lsof).", {
      cause: result.error,
    });
  }
  return [...new Set(result.stdout.split(/\s+/u).map(Number))].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
  );
};

/**
 * What the home looked like with no seed or setup in it: undefined while one holds the home or
 * left a journal. Two equal readings around a copy mean nothing was published in between.
 */
const homeGeneration = (home) => {
  if (homeIsLocked(home) || exists(NodePath.join(home.stateDir, JOURNAL))) return undefined;
  return [
    readBytes(NodePath.join(home.stateDir, DEV_IDENTITY_MARKER))?.toString("base64") ?? "",
    readBytes(NodePath.join(home.stateDir, "secrets", `${VAULT_SENTINEL}.bin`))?.toString(
      "base64",
    ) ?? "",
  ].join("|");
};

/** Removes the private staging folder an earlier copy left behind if it stopped. */
const clearStaging = (stateDir) =>
  NodeFS.rmSync(NodePath.join(stateDir, STAGING_DIR), { recursive: true, force: true });

/**
 * Copies the home's identity into a dev app that is about to start. Runs while no app of that
 * checkout is running; the home may be running, so its files are read as one snapshot, and a
 * seed that published, held or stopped in the home during the read voids the copy. Nothing in
 * the target changes until every replacement is staged, and an interrupted copy is finished.
 */
export async function importDevIdentity({
  targetStateDir,
  home = resolveDevIdentityHome(),
  installed = resolveInstalledApp(),
  environment = process.env,
  now = () => new Date(),
} = {}) {
  if (isHomeTarget(targetStateDir, home)) {
    let readiness;
    try {
      readiness = prepareHomeStart({
        checkoutRoot: NodePath.dirname(NodePath.dirname(targetStateDir)),
        stateRoot: NodePath.dirname(targetStateDir),
        home,
        installed,
      });
    } catch (error) {
      if (error?.fatal) throw error;
      throw new DevIdentityFatalError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    return { status: readiness === "seeding" ? "home-seeding" : "home" };
  }
  if (isProtectedTarget(targetStateDir, home, installed)) return { status: "refused-target" };
  assertPlainTarget(targetStateDir);
  // One copy or recovery at a time per app: a direct start may race a managed one.
  const releaseState = lockStateDir(targetStateDir);
  try {
    return await copyIdentity({ targetStateDir, home, environment, now });
  } finally {
    releaseState();
  }
}

const STATE_LOCK = "dev-identity-copy-lock.sqlite";

/**
 * Holds one app's copy lock, the same kind of process-held SQLite lock as the seed's: a copy, a
 * recovery and a staging cleanup in that app never interleave, whichever command runs them.
 */
function lockStateDir(stateDir) {
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Waits for another start of the same app to finish its copy.
  const database = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, STATE_LOCK), {
    timeout: 60_000,
  });
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    throw new DevIdentityFatalError(
      isBusy(error)
        ? "Another start of this dev app is still copying its identity; start it again when it finishes."
        : `Could not lock ${stateDir} for the identity copy.`,
      { cause: error },
    );
  }
  return () => {
    database.exec("ROLLBACK");
    database.close();
  };
}

/** The copy itself, run under the app's copy lock. */
async function copyIdentity({ targetStateDir, home, environment, now }) {
  recoverInterruptedCopy(targetStateDir);
  clearStaging(targetStateDir);
  retireCopiedOAuthGrants(targetStateDir);
  if (environment[DEV_IDENTITY_ENV] === "off") {
    stopBorrowing(targetStateDir);
    return { status: "disabled" };
  }
  if (!exists(home.stateDir)) return { status: "no-home" };
  if (exists(NodePath.join(home.stateDir, JOURNAL))) return { status: "home-interrupted" };
  const generation = homeGeneration(home);
  if (generation === undefined) return { status: "home-busy" };
  const protection = vaultProtection(home.stateDir);
  if (protection !== "file" && protection !== "none") {
    return { status: "home-vault-not-portable", protection };
  }
  const capture = captureIdentity(home.stateDir);
  if (capture === undefined) return { status: "home-busy" };
  let target = {};
  if (protection === "file") {
    try {
      target = readTargetVault(targetStateDir, { replaced: replacedByCopy });
    } catch (error) {
      if (!(error instanceof TargetVaultError)) throw error;
      return { status: "target-vault-not-portable", reason: error.message };
    }
  }
  const firstStart =
    !exists(NodePath.join(targetStateDir, "settings.json")) &&
    !exists(NodePath.join(targetStateDir, "client-settings.json"));
  NodeFS.mkdirSync(targetStateDir, { recursive: true, mode: 0o700 });
  const paths = { sourceDirs: homeStateDirs(home), targetDir: targetStateDir };

  const changes = new StagedChanges(targetStateDir);
  let secrets = [];
  let websites = { copied: [], skipped: [] };
  try {
    const sourceKey = capture.secrets.get(`${VAULT_KEY_FILE}.bin`);
    const ownGrants =
      protection === "file"
        ? ownOAuthGrants({ targetStateDir, targetKey: target.key, capture })
        : new Map();
    if (protection === "file") {
      secrets = stageSecrets({ changes, capture, sourceKey, targetStateDir, target, ownGrants });
    }
    stageSettings({ changes, capture, targetStateDir, ...paths, fullProfile: firstStart });
    stageConnectors({
      changes,
      capture,
      targetStateDir,
      ...paths,
      ownGrants,
      written: new Set(secrets),
      borrowed:
        protection === "file"
          ? borrowableOAuthConnectors({ capture, sourceKey, owned: ownGrants })
          : new Map(),
      homeStateDir: home.stateDir,
    });
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
  } finally {
    clearStaging(targetStateDir);
  }
  // A seed that began, held, finished or stopped in the home during the read voids what was read.
  const after = homeGeneration(home);
  if (after === undefined || after !== generation) {
    changes.abort();
    return { status: "home-busy" };
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
  changes.commit();
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
    case "home-interrupted":
      return "A seed of the dev identity home stopped partway; start the identity home app or run the seed again to finish it. This dev app starts with the identity it already had.";
    case "target-vault-not-portable":
      return `This dev app keeps its own accounts (${result.reason}). Move its .scient-next aside to start it with your dev identity.`;
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

/**
 * The home's app writes its own files; seeding and moving the home wait until it is closed. It
 * counts as running while any process has the home's databases open, while a runner that claimed
 * the home lives, and while a launcher runner lives or briefly before it records its process.
 */
export function homeAppIsRunning(
  home = resolveDevIdentityHome(),
  isAlive = processIsAlive,
  now = Date.now,
  usingHome = processesUsingHome,
) {
  for (const file of ["electron.pid", "backend.pid"]) {
    const pid = Number.parseInt(
      readText(NodePath.join(home.root, "local-dev-app-runtime", file)) ?? "",
      10,
    );
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return true;
  }
  const runners = NodePath.join(home.root, RUNNERS_DIR);
  for (const name of exists(runners) ? NodeFS.readdirSync(runners) : []) {
    if (!name.endsWith(".json")) continue;
    const receipt = readJsonObject(NodePath.join(runners, name));
    if (receipt === undefined) return true;
    if (Number.isInteger(receipt.pid) && receipt.pid > 0 && isAlive(receipt.pid)) return true;
    for (const group of Array.isArray(receipt.processGroups) ? receipt.processGroups : []) {
      if (Number.isInteger(group) && group > 1 && isAlive(-group)) return true;
    }
  }
  if (usingHome(home).length > 0) return true;
  const runnerDir = NodePath.join(home.root, "local-dev-app-runner");
  if (!exists(runnerDir)) return false;
  const pid = readJsonObject(NodePath.join(runnerDir, "state.json"))?.pid;
  if (Number.isInteger(pid) && pid > 0) return isAlive(pid);
  return now() - NodeFS.statSync(runnerDir).mtimeMs < RUNNER_START_GRACE_MS;
}

/** The home's state must be a real folder inside the home, apart from the installed app. */
function assertHomeLayout(home, installed) {
  if (within(home.root, installed.stateDir) || within(installed.stateDir, home.root)) {
    throw new Error("The installed app's data and the identity home overlap; nothing was copied.");
  }
  if (isLink(home.stateDir) || !within(home.stateDir, home.root)) {
    throw new Error(`${home.stateDir} leads outside ${home.root}; nothing was copied.`);
  }
  if (exists(home.stateDir)) assertPlainTarget(home.stateDir);
}

/** The home app must run code that honours this module's lock and journal. */
function assertHomeCheckoutMatches(home) {
  const checkout = homeCheckout(home);
  if (checkout === undefined) return;
  const source = readText(NodePath.join(checkout, "scripts", "dev-identity.mjs")) ?? "";
  if (!source.includes(`export const DEV_IDENTITY_PROTOCOL = ${String(DEV_IDENTITY_PROTOCOL)};`)) {
    throw new Error(
      `${checkout} runs an older dev identity version; check out a newer commit there before seeding.`,
    );
  }
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
} = {}) {
  const release = acquireHomeLock(home);
  try {
    if (isRunning(home)) {
      throw new Error("Quit Scient (Dev) · identity first (pnpm dev:app:stop in its checkout).");
    }
    if (!exists(installed.stateDir)) {
      throw new Error(`No installed Scient data at ${installed.stateDir}.`);
    }
    assertHomeLayout(home, installed);
    assertHomeCheckoutMatches(home);
    recoverInterruptedCopy(home.stateDir);
    clearStaging(home.stateDir);
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
    let target;
    try {
      target = readTargetVault(home.stateDir, { replaced: replacedByCopy });
    } catch (error) {
      if (!(error instanceof TargetVaultError)) throw error;
      throw new Error(`The identity home was left as it was: ${error.message}.`, { cause: error });
    }
    const ownGrants = ownOAuthGrants({
      targetStateDir: home.stateDir,
      targetKey: target.key,
      capture,
    });
    const changes = new StagedChanges(home.stateDir);
    try {
      const written = stageSecrets({
        changes,
        capture,
        sourceKey,
        targetStateDir: home.stateDir,
        target,
        ownGrants,
      });
      report.secrets = written.length;
      stageSettings({
        changes,
        capture,
        targetStateDir: home.stateDir,
        ...paths,
        fullProfile: true,
      });
      stageConnectors({
        changes,
        capture,
        targetStateDir: home.stateDir,
        ...paths,
        ownGrants,
        written: new Set(written),
      });
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
    } finally {
      clearStaging(home.stateDir);
    }
    changes.commit();
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
  installed = resolveInstalledApp(),
  run = (command, args, options) =>
    NodeChildProcess.execFileSync(command, args, { stdio: "inherit", ...options }),
  readGitFile = (cwd, spec) => {
    try {
      return NodeChildProcess.execFileSync("git", ["-C", cwd, "show", spec], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
  },
  isRunning = homeAppIsRunning,
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
    if (!sameFile(link, home.root)) {
      throw new Error(`${link} points somewhere other than ${home.root}.`);
    }
  }
  const release = acquireHomeLock(home);
  try {
    assertHomeLayout(home, installed);
    // Moving the home to another checkout while its app runs would let a second app open it.
    const registered = homeCheckout(home);
    if (registered !== undefined && !sameFile(registered, checkout) && isRunning(home)) {
      throw new Error(
        `The identity home is running from ${registered}; stop it there (pnpm dev:app:stop) before moving it to ${checkout}.`,
      );
    }
    NodeFS.mkdirSync(home.stateDir, { recursive: true, mode: 0o700 });
    if (!exists(checkout)) {
      if (ref === "origin/main") run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", "main"]);
      const blob = readGitFile(repoRoot, `${ref}:scripts/dev-identity.mjs`) ?? "";
      if (
        !blob.includes(`export const DEV_IDENTITY_PROTOCOL = ${String(DEV_IDENTITY_PROTOCOL)};`)
      ) {
        throw new Error(`${ref} does not have this dev identity version; pass a newer --ref.`);
      }
      run("git", ["-C", repoRoot, "worktree", "add", "--detach", checkout, ref]);
    }
    const source = readText(NodePath.join(checkout, "scripts", "dev-identity.mjs")) ?? "";
    if (
      !source.includes(`export const DEV_IDENTITY_PROTOCOL = ${String(DEV_IDENTITY_PROTOCOL)};`)
    ) {
      throw new Error(
        `${checkout} is at a commit without this dev identity version; check out a newer commit there.`,
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
