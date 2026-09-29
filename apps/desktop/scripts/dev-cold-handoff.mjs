import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const COLD_HANDOFF_SCHEMA = "scient-next.dev-cold-handoff/v1";
export const COLD_HANDOFF_MAX_AGE_MS = 45_000;
export const COLD_HANDOFF_CLAIM_MAX_AGE_MS = 10 * 60_000;
export const APPROVED_HANDOFF_MAX_AGE_MS = 30 * 60_000;
export const COLD_HANDOFF_MAX_FILES = 8;
export const APPROVED_HANDOFF_SCHEMA = "scient-next.dev-approved-handoff/v1";
const decimal = /^(?:0|[1-9][0-9]*)$/u;
const noncePattern = /^[a-f0-9]{64}$/u;

export function coldHandoffDirectory(stateRoot) {
  return NodePath.join(stateRoot, "local-dev-app-runtime", "cold-handoffs");
}

function assertPath(filePath, stateRoot, suffix) {
  const name = NodePath.basename(filePath);
  if (
    NodePath.dirname(NodePath.resolve(filePath)) !== coldHandoffDirectory(stateRoot) ||
    !new RegExp(`^cold-[a-f0-9]{64}\\${suffix}$`, "u").test(name)
  )
    throw new Error("Cold handoff path is outside this dev app state root.");
}

function assertReceipt(value, { root, role, now, maxAge }) {
  if (
    value?.schema !== COLD_HANDOFF_SCHEMA ||
    value.root !== root ||
    value.role !== role ||
    !Number.isInteger(value.coldPid) ||
    value.coldPid <= 0 ||
    typeof value.coldStart !== "string" ||
    value.coldStart.length > 80 ||
    !value.coldStart ||
    typeof value.nonce !== "string" ||
    !noncePattern.test(value.nonce) ||
    !Number.isInteger(value.createdAt) ||
    !Number.isInteger(value.expiresAt) ||
    value.createdAt > now + 1000 ||
    now - value.createdAt > maxAge ||
    value.expiresAt !== value.createdAt + COLD_HANDOFF_MAX_AGE_MS ||
    !Array.isArray(value.files) ||
    value.files.length > COLD_HANDOFF_MAX_FILES ||
    value.files.some(
      (file) =>
        typeof file?.path !== "string" ||
        !NodePath.isAbsolute(file.path) ||
        !file.path.toLowerCase().endsWith(".scic") ||
        file.readOnly !== false ||
        ["dev", "ino", "size", "mtimeNs"].some(
          (key) => typeof file?.identity?.[key] !== "string" || !decimal.test(file.identity[key]),
        ),
    )
  )
    throw new Error("Invalid or expired cold conversation handoff.");
  return value;
}

function privateDirectory(stateRoot) {
  const directory = coldHandoffDirectory(stateRoot);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("Cold handoff directory is not private to this user.");
  }
  return directory;
}

function readPrivate(filePath, expected, { root, role, now, maxAge }) {
  const fd = NodeFS.openSync(
    filePath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = NodeFS.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16_384 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("Cold handoff is not a private, bounded local file.");
    }
    const receipt = assertReceipt(JSON.parse(NodeFS.readFileSync(fd, "utf8")), {
      root,
      role,
      now,
      maxAge,
    });
    if (
      NodePath.basename(expected) !== `cold-${receipt.nonce}.claim` &&
      NodePath.basename(expected) !== `cold-${receipt.nonce}.json`
    ) {
      throw new Error("Cold handoff nonce does not match its filename.");
    }
    return receipt;
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function writeColdHandoff({
  stateRoot,
  root,
  role,
  coldPid,
  coldStart,
  files,
  now = Date.now(),
}) {
  const nonce = NodeCrypto.randomBytes(32).toString("hex");
  const receipt = assertReceipt(
    {
      schema: COLD_HANDOFF_SCHEMA,
      root,
      role,
      coldPid,
      coldStart,
      nonce,
      createdAt: now,
      expiresAt: now + COLD_HANDOFF_MAX_AGE_MS,
      files,
    },
    { root, role, now, maxAge: COLD_HANDOFF_MAX_AGE_MS },
  );
  const filePath = NodePath.join(privateDirectory(stateRoot), `cold-${nonce}.json`);
  NodeFS.writeFileSync(filePath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  return { path: filePath, nonce };
}

export function claimColdHandoff({ path, stateRoot, root, role, now = Date.now() }) {
  privateDirectory(stateRoot);
  assertPath(path, stateRoot, ".json");
  const claimPath = path.replace(/\.json$/u, ".claim");
  if (NodeFS.existsSync(claimPath)) throw new Error("Cold handoff has already been claimed.");
  // Rename is the one-owner transition: a second claimant sees ENOENT.
  NodeFS.renameSync(path, claimPath);
  try {
    const receipt = readPrivate(claimPath, claimPath, {
      root,
      role,
      now,
      maxAge: COLD_HANDOFF_MAX_AGE_MS,
    });
    return { path: claimPath, receipt };
  } catch (error) {
    NodeFS.rmSync(claimPath, { force: true });
    throw error;
  }
}

export function takeClaimedColdHandoff({ path, stateRoot, root, role, now = Date.now() }) {
  privateDirectory(stateRoot);
  assertPath(path, stateRoot, ".claim");
  const consumingPath = `${path}.${NodeCrypto.randomBytes(16).toString("hex")}.taking`;
  NodeFS.renameSync(path, consumingPath);
  try {
    return readPrivate(consumingPath, path, {
      root,
      role,
      now,
      maxAge: COLD_HANDOFF_CLAIM_MAX_AGE_MS,
    });
  } finally {
    NodeFS.rmSync(consumingPath, { force: true });
  }
}

export function readClaimedColdHandoff({ path, stateRoot, root, role, now = Date.now() }) {
  privateDirectory(stateRoot);
  assertPath(path, stateRoot, ".claim");
  return readPrivate(path, path, {
    root,
    role,
    now,
    maxAge: COLD_HANDOFF_CLAIM_MAX_AGE_MS,
  });
}

export function processStartToken(pid, { spawnSync = NodeChildProcess.spawnSync } = {}) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  const token = result.status === 0 ? result.stdout.trim() : "";
  return token || null;
}

export function writeApprovedHandoff({ stateRoot, root, role, files, now = Date.now() }) {
  const nonce = NodeCrypto.randomBytes(32).toString("hex");
  const receipt = { schema: APPROVED_HANDOFF_SCHEMA, root, role, nonce, createdAt: now, files };
  assertReceipt(
    {
      ...receipt,
      schema: COLD_HANDOFF_SCHEMA,
      coldPid: process.pid,
      coldStart: "supervisor",
      expiresAt: now + COLD_HANDOFF_MAX_AGE_MS,
    },
    { root, role, now, maxAge: COLD_HANDOFF_MAX_AGE_MS },
  );
  const filePath = NodePath.join(privateDirectory(stateRoot), `approved-${nonce}.json`);
  NodeFS.writeFileSync(filePath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  return filePath;
}

export function takeApprovedHandoff({ path, stateRoot, root, role, now = Date.now() }) {
  privateDirectory(stateRoot);
  if (
    NodePath.dirname(NodePath.resolve(path)) !== coldHandoffDirectory(stateRoot) ||
    !/^approved-[a-f0-9]{64}\.json$/u.test(NodePath.basename(path))
  ) {
    throw new Error("Approved handoff path is outside this dev app state root.");
  }
  const consumingPath = `${path}.${NodeCrypto.randomBytes(16).toString("hex")}.taking`;
  NodeFS.renameSync(path, consumingPath);
  try {
    const fd = NodeFS.openSync(
      consumingPath,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = NodeFS.fstatSync(fd);
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 16_384 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        throw new Error("Approved handoff is not a private, bounded local file.");
      }
      const value = JSON.parse(NodeFS.readFileSync(fd, "utf8"));
      if (
        value?.schema !== APPROVED_HANDOFF_SCHEMA ||
        value.root !== root ||
        value.role !== role ||
        !noncePattern.test(value.nonce) ||
        NodePath.basename(path) !== `approved-${value.nonce}.json` ||
        !Number.isInteger(value.createdAt) ||
        now - value.createdAt > APPROVED_HANDOFF_MAX_AGE_MS ||
        value.createdAt > now + 1000
      ) {
        throw new Error("Invalid or expired approved conversation handoff.");
      }
      assertReceipt(
        {
          ...value,
          schema: COLD_HANDOFF_SCHEMA,
          coldPid: process.pid,
          coldStart: "supervisor",
          expiresAt: value.createdAt + COLD_HANDOFF_MAX_AGE_MS,
        },
        { root, role, now: value.createdAt, maxAge: COLD_HANDOFF_MAX_AGE_MS },
      );
      return value.files;
    } finally {
      NodeFS.closeSync(fd);
    }
  } finally {
    NodeFS.rmSync(consumingPath, { force: true });
  }
}
