// @effect-diagnostics nodeBuiltinImport:off -- bounded catalog IO and private recipe cache boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import {
  ComputeRecipeCatalog,
  recipeIdentity,
  validateRecipeFiles,
  type ComputeRecipe,
} from "./ComputeRecipe.ts";
import bundledJson from "./managed-python/bundled-recipes.json" with { type: "json" };
import type { ManagedPythonEnvironmentStatus } from "./ManagedPythonEnvironment.ts";

const decodeCatalogValue = Schema.decodeUnknownSync(ComputeRecipeCatalog);
export const bundledRecipes = decodeCatalogValue(bundledJson);
/** Qualification must exercise its candidate, never whatever the public feed offers. */
export const ComputeRecipeNetwork = Context.Reference<boolean>("scient/compute/recipeNetwork", {
  defaultValue: () => true,
});
export const COMPUTE_CATALOG_URL =
  "https://raw.githubusercontent.com/ScientFactory/scient-desktop/automation/compute-recipes-v1/catalog.json";
const ROOT = "https://raw.githubusercontent.com/ScientFactory/scient-desktop";
const MAX_BYTES = 4 * 1024 * 1024;
const TTL = 60 * 60 * 1000;
const RETRY = 5 * 60 * 1000;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ComputeRecipeCatalog));
class RecipeUnavailable extends Error {}

export interface ComputeRecipeSource {
  latest(): ComputeRecipe | null;
  refresh(force?: boolean): Promise<void>;
  state(): "current" | "checking" | "cached" | "unavailable";
  prepare(
    action: "install" | "update" | "repair" | "toolkits",
    current: ManagedPythonEnvironmentStatus | null,
    signal: AbortSignal,
  ): Promise<{ recipe: ComputeRecipe; specDirectory: string }>;
  dispose(): void;
}

export function mergeComputeCatalog(
  current: ComputeRecipeCatalog,
  next: ComputeRecipeCatalog,
): ComputeRecipeCatalog {
  if (next.sequence <= current.sequence) return current;
  const seen = new Set<string>();
  for (const candidate of next.recipes) {
    const key = `${candidate.purpose}:${candidate.revision}`;
    if (seen.has(key)) throw new Error("Duplicate Compute recipe revision.");
    seen.add(key);
    const previous = current.recipes.find(
      (entry) => entry.purpose === candidate.purpose && entry.revision === candidate.revision,
    );
    if (previous && recipeIdentity(previous) !== recipeIdentity(candidate))
      throw new Error("A published Compute recipe cannot be replaced.");
    if (
      !candidate.sourceCommit &&
      (!previous || recipeIdentity(previous) !== recipeIdentity(candidate))
    )
      throw new Error("Published recipes require an immutable source commit.");
  }
  const history = [
    ...current.recipes.filter((entry) => !seen.has(`${entry.purpose}:${entry.revision}`)),
    ...next.recipes,
  ];
  return decodeCatalogValue({
    ...next,
    // History allows pinned repair; withdrawal is explicit and retained monotonically.
    withdrawn: [...new Set([...current.withdrawn, ...next.withdrawn])],
    // A frequently updated Python must not evict the independent MATLAB track.
    recipes: (["python", "matlab-connection"] as const).flatMap((purpose) =>
      history
        .filter((entry) => entry.purpose === purpose)
        .sort((a, b) => b.revision - a.revision)
        .slice(0, 32),
    ),
  });
}

async function boundedFile(path: string): Promise<string> {
  const file = await NodeFSP.open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid Compute recipe file.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw new Error("Compute recipe exceeds the size limit.");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

/** Cancelling one client must not cancel a catalog request shared by other clients. */
function waitForRefresh(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    void pending.then(
      () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

async function directory(path: string): Promise<void> {
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await NodeFSP.lstat(path)).isDirectory())
    throw new Error("Compute recipe cache is not an owned directory.");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.unlink(temporary).catch(() => undefined);
  }
}

/** One source per runtime binding; all connected clients share its requests and cache. */
export function makeComputeRecipeSource(input: {
  computeDir: string;
  specDirectory: string;
  purpose: ComputeRecipe["purpose"];
  target: string;
  fetch?: (url: string, options?: RequestInit) => Promise<Response>;
  now?: () => number;
  network?: boolean;
}): ComputeRecipeSource {
  const bundled = bundledRecipes.recipes.find((entry) => entry.purpose === input.purpose)!;
  const root = NodePath.join(input.computeDir, "recipe-cache", input.purpose);
  const cachePath = NodePath.join(root, "catalog.json");
  const request = input.fetch ?? fetch;
  const now = input.now ?? (() => performance.timeOrigin + performance.now());
  const lifetime = new AbortController();
  let catalog = bundledRecipes;
  let freshness: ReturnType<ComputeRecipeSource["state"]> = "cached";
  let nextRefresh = 0;
  let inflight: Promise<void> | null = null;
  let loading: Promise<void> | null = null;
  let etag: string | undefined;

  const loadCache = () =>
    (loading ??= (async () => {
      await directory(input.computeDir);
      await directory(NodePath.dirname(root));
      await directory(root);
      const saved = await boundedFile(cachePath).catch(() => null);
      if (saved) {
        try {
          catalog = mergeComputeCatalog(catalog, decodeCatalog(saved));
        } catch {
          /* Corrupt cache never replaces the shipped recipe. */
        }
      }
    })());

  const read = async (url: string, signal: AbortSignal, tag?: string) => {
    const response = await request(url, {
      signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
      ...(tag ? { headers: { "If-None-Match": tag } } : {}),
    }).catch((cause) => {
      throw new RecipeUnavailable("Compute update source is unavailable.", { cause });
    });
    if (response.status === 304) return { text: null, etag: tag };
    if (!response.ok || !response.body)
      throw new RecipeUnavailable("Compute update catalog is unavailable.");
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_BYTES) break;
        chunks.push(result.value);
      }
    } catch (cause) {
      throw new RecipeUnavailable("Compute update download was interrupted.", { cause });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (bytes > MAX_BYTES) throw new Error("Compute recipe exceeds the size limit.");
    return {
      text: Buffer.concat(chunks).toString("utf8"),
      etag: response.headers.get("etag") ?? undefined,
    };
  };
  const refresh = (force = false): Promise<void> => {
    if (input.network === false) return Promise.resolve();
    if (lifetime.signal.aborted || (!force && now() < nextRefresh)) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await loadCache();
        const result = await read(COMPUTE_CATALOG_URL, lifetime.signal, etag);
        if (result.text !== null) {
          const next = mergeComputeCatalog(catalog, decodeCatalog(result.text));
          lifetime.signal.throwIfAborted();
          await atomicWrite(cachePath, JSON.stringify(next));
          catalog = next;
        }
        etag = result.etag;
        freshness = "current";
        nextRefresh = now() + TTL;
      } catch {
        freshness = "unavailable";
        nextRefresh = now() + RETRY;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  const compatible = (entry: ComputeRecipe) =>
    entry.purpose === input.purpose &&
    entry.uvVersion === bundled.uvVersion &&
    entry.capabilitySha256 === bundled.capabilitySha256 &&
    // Preserve the app bundle's existing provisioner support; remote recipes need native qualification.
    (recipeIdentity(entry) === recipeIdentity(bundled) ||
      entry.targets.includes(input.target as ComputeRecipe["targets"][number])) &&
    // MATLAB's vendor-qualified host remains independent of Scientific Python.
    (input.purpose !== "matlab-connection" || entry.pythonVersion === bundled.pythonVersion);
  const latest = () =>
    [bundled, ...catalog.recipes]
      .filter((entry) => compatible(entry) && !catalog.withdrawn.includes(recipeIdentity(entry)))
      .sort((a, b) => b.revision - a.revision)[0] ?? null;
  const prepare: ComputeRecipeSource["prepare"] = async (action, current, signal) => {
    signal = AbortSignal.any([signal, lifetime.signal]);
    signal.throwIfAborted();
    // Read persisted withdrawals even when Repair precedes the first status query.
    await waitForRefresh(loadCache(), signal);
    if (action === "install" || action === "update") await waitForRefresh(refresh(true), signal);
    signal.throwIfAborted();
    const installed = current?.record.active;
    const recipe =
      action === "repair" || action === "toolkits"
        ? (installed?.recipe ??
          catalog.recipes.find(
            (entry) =>
              entry.purpose === input.purpose &&
              entry.toolkitRevision === installed?.toolkitRevision &&
              entry.pythonVersion === installed?.pythonVersion,
          ))
        : latest();
    if (!recipe)
      throw new Error(
        "No compatible qualified recipe is available. Update Scient or choose an existing environment.",
      );
    if (installed?.recipe && action === "update" && recipe.revision < installed.recipe.revision)
      throw new Error("An older catalog cannot downgrade the installed environment.");
    if (
      installed &&
      action === "update" &&
      recipe.pythonVersion.localeCompare(installed.pythonVersion, "en", { numeric: true }) < 0
    )
      throw new Error("An update cannot downgrade the installed Python version.");
    if (
      installed &&
      !installed.recipe &&
      action === "update" &&
      (recipe.toolkitRevision.localeCompare(installed.toolkitRevision, "en", { numeric: true }) <
        0 ||
        recipe.pythonVersion.localeCompare(installed.pythonVersion, "en", { numeric: true }) < 0)
    )
      throw new Error("An older catalog cannot downgrade the installed environment.");
    if (catalog.withdrawn.includes(recipeIdentity(recipe)))
      throw new Error(
        "This recipe was withdrawn. Choose a qualified update before changing this environment.",
      );
    if (recipe.uvVersion !== bundled.uvVersion)
      throw new Error(
        "This environment requires a different installer. Update Scient before repairing it.",
      );
    const baseline = await NodeFSP.readFile(
      NodePath.join(input.specDirectory, "pyproject.toml"),
      "utf8",
    );
    const validate = async (path: string, selected = recipe) => {
      const [project, lock] = await Promise.all(
        ["pyproject.toml", "uv.lock"].map((file) => boundedFile(NodePath.join(path, file))),
      );
      validateRecipeFiles(selected, project!, lock!, baseline);
      return { recipe: selected, specDirectory: path };
    };
    if (current && installed && (action === "repair" || action === "toolkits")) {
      const project = NodePath.join(
        NodePath.dirname(NodePath.dirname(NodePath.dirname(current.executable))),
        "project",
      );
      try {
        return await validate(project);
      } catch {
        signal.throwIfAborted();
      }
    }
    if (recipeIdentity(recipe) === recipeIdentity(bundled)) return validate(input.specDirectory);
    await directory(root);
    const destination = NodePath.join(root, recipeIdentity(recipe));
    await directory(destination);
    try {
      return await validate(destination);
    } catch {
      signal.throwIfAborted();
    }
    const suffix = recipe.purpose === "python" ? "" : "/matlab-connection";
    const url = `${ROOT}/${recipe.sourceCommit}/apps/server/src/scient/compute/managed-python${suffix}`;
    const downloaded = await Promise.all([
      read(`${url}/pyproject.toml`, signal),
      read(`${url}/uv.lock`, signal),
    ]).catch(async (cause) => {
      signal.throwIfAborted();
      if (
        action !== "install" ||
        current ||
        !(cause instanceof RecipeUnavailable) ||
        catalog.withdrawn.includes(recipeIdentity(bundled))
      )
        throw cause;
      return null;
    });
    // First installation offline can use the shipped recipe. Update must never fall back or downgrade.
    if (!downloaded) return validate(input.specDirectory, bundled);
    const [project, lock] = downloaded;
    if (project.text === null || lock.text === null) throw new Error("Incomplete Compute recipe.");
    validateRecipeFiles(recipe, project.text, lock.text, baseline);
    signal.throwIfAborted();
    await atomicWrite(NodePath.join(destination, "pyproject.toml"), project.text);
    await atomicWrite(NodePath.join(destination, "uv.lock"), lock.text);
    return validate(destination);
  };
  return {
    latest,
    refresh,
    state: () => (inflight ? "checking" : freshness),
    prepare,
    dispose: () => lifetime.abort(),
  };
}
