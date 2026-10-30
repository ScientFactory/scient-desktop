// @effect-diagnostics nodeBuiltinImport:off -- canonical path validation needs node:path.
import * as NodePath from "node:path";

/**
 * Python/Jupyter overrides would change how the bridge loads, and the app's own sign-in tokens
 * are not the user's. The user's own credentials (cloud, API keys) stay available to their code, as in
 * their terminal. This is hygiene, not sandboxing.
 */
export const ENVIRONMENT_DENYLIST: ReadonlyArray<string> = [
  // Python overrides that could change bridge code resolution.
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONEXECUTABLE",
  // Filter code-loading Jupyter/IPython overrides, but preserve JUPYTER_RUNTIME_DIR: it cannot
  // introduce code and may name a container's only writable connection-file directory.
  "JUPYTER_CONFIG_DIR",
  "JUPYTER_PATH",
  "JUPYTER_DATA_DIR",
  "IPYTHONDIR",
  // Sign-in tokens the application itself holds for its providers and GitHub.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "GH_TOKEN",
  "ELECTRON_RUN_AS_NODE",
] as const;

/** Scient/T3-owned configuration namespaces that user code should not inherit. */
export const ENVIRONMENT_PREFIX_DENYLIST: ReadonlyArray<string> = [
  "SCIENT_",
  "T3_",
  "T3CODE_",
  "FF_",
  "FFF_",
] as const;

/**
 * Sets UTF-8 and unbuffered behavior so Python output is correct and prompt.
 */
const ENVIRONMENT_OVERRIDES: Readonly<Record<string, string>> = {
  PYTHONUTF8: "1",
  PYTHONUNBUFFERED: "1",
} as const;

/**
 * Reject malformed/noncanonical absolute cwd as a caller defect. Do not realpath it: authorization
 * approved the written path, and resolving symlinks would silently change that root (including
 * macOS /tmp).
 */
export function validateProjectRoot(root: string): string {
  if (!NodePath.isAbsolute(root)) {
    throw new Error(`Project root must be an absolute path, received: ${root}`);
  }
  const resolved = NodePath.resolve(root);
  if (resolved !== root) {
    throw new Error(`Project root must be canonical, received: ${root}, resolved: ${resolved}`);
  }
  return resolved;
}

/**
 * Fold environment keys case-insensitively for Windows; conservative over-removal is safer than
 * missing an override on Unix. Use locale-independent uppercasing so Turkish casing cannot change
 * policy.
 */
const canonicalKey = (key: string): string => key.toUpperCase();

const DENIED_KEYS: ReadonlySet<string> = new Set(ENVIRONMENT_DENYLIST.map(canonicalKey));
const DENIED_PREFIXES: ReadonlyArray<string> = ENVIRONMENT_PREFIX_DENYLIST.map(canonicalKey);

function isDenied(key: string): boolean {
  const canonical = canonicalKey(key);
  if (DENIED_KEYS.has(canonical)) return true;
  return DENIED_PREFIXES.some((prefix) => canonical.startsWith(prefix));
}

/**
 * Use extendEnv false with this complete sanitized record or host variables return. Never log
 * values; expose only removed key names for observability.
 */
export function sanitizeComputeEnvironment(hostEnv: Readonly<Record<string, string>>): {
  readonly environment: Record<string, string>;
  readonly removedKeys: ReadonlyArray<string>;
} {
  const removed: string[] = [];
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(hostEnv)) {
    if (isDenied(key)) {
      removed.push(key);
    } else {
      env[key] = value;
    }
  }

  // A differently-cased copy of an override key would sit beside it in the
  // record and win on Windows, where the two are the same variable. Take the
  // host's spelling out before putting ours in, so the launch has exactly one.
  const overridden = new Set(Object.keys(ENVIRONMENT_OVERRIDES).map(canonicalKey));
  for (const key of Object.keys(env)) {
    if (overridden.has(canonicalKey(key))) delete env[key];
  }
  Object.assign(env, ENVIRONMENT_OVERRIDES);

  return { environment: env, removedKeys: removed };
}
