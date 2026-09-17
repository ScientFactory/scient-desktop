// @effect-diagnostics nodeBuiltinImport:off -- isolated cache and immutable source fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import {
  ComputeRecipeCatalog,
  recipeHash,
  recipeIdentity,
  sealComputeRecipe,
  validateRecipeFiles,
  type ComputeRecipe,
} from "./ComputeRecipe.ts";
import {
  bundledRecipes,
  COMPUTE_CATALOG_URL,
  makeComputeRecipeSource,
  mergeComputeCatalog,
  type ComputeRecipeSource,
} from "./ComputeRecipeSource.ts";
import type { ManagedPythonEnvironmentStatus } from "./ManagedPythonEnvironment.ts";
import { ComputeToolkitId } from "@scientfactory/compute";
import * as Schema from "effect/Schema";
const decodeCatalog = Schema.decodeUnknownSync(ComputeRecipeCatalog);

describe("qualified Compute recipes", () => {
  let root: string;
  let clock: number;
  let project: string;
  let lock: string;
  const specDirectory = NodePath.join(import.meta.dirname, "managed-python");
  const baseline = bundledRecipes.recipes[0]!;
  const sources: ComputeRecipeSource[] = [];
  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "compute-recipes-"));
    clock = 1000;
    project = await NodeFSP.readFile(NodePath.join(specDirectory, "pyproject.toml"), "utf8");
    lock = await NodeFSP.readFile(NodePath.join(specDirectory, "uv.lock"), "utf8");
  });
  afterEach(async () => {
    sources.forEach((source) => source.dispose());
    sources.length = 0;
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const candidate = () => ({
    ...baseline,
    revision: baseline.revision + 1,
    toolkitRevision: "scientific-python-2026-09-18.1",
    sourceCommit: "a".repeat(40),
  });
  const feed = (): ComputeRecipeCatalog => ({
    schemaVersion: 1,
    sequence: 2,
    recipes: [candidate()],
    withdrawn: [],
  });
  type Request = (url: string, options?: RequestInit) => Promise<Response>;
  const source = (request: Request, target = "darwin-arm64") => {
    const result = makeComputeRecipeSource({
      computeDir: root,
      specDirectory,
      purpose: "python",
      target,
      fetch: request,
      now: () => clock,
    });
    sources.push(result);
    return result;
  };
  const requestFor = (catalog = feed()) =>
    vi.fn<Request>(
      async (url) =>
        new Response(
          url === COMPUTE_CATALOG_URL
            ? JSON.stringify(catalog)
            : String(url).endsWith("uv.lock")
              ? lock
              : project,
          { headers: { etag: "test-tag" } },
        ),
    );
  const installed = (recipe: ComputeRecipe = candidate()): ManagedPythonEnvironmentStatus => ({
    available: true,
    executable: NodePath.join(root, "generation-old/environment/bin/python"),
    record: {
      schemaVersion: 1,
      selection: "managed",
      previous: null,
      active: {
        generationId: "old",
        executableRelativePath: "environment/bin/python",
        toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
        toolkitRevision: recipe.toolkitRevision,
        pythonVersion: recipe.pythonVersion,
        provisionerVersion: `uv-${recipe.uvVersion}-shared-python-v1`,
        activatedAtEpochMs: 0,
        recipe,
      },
    },
  });
  it("validates both bundled manifests and every lock artifact", async () => {
    validateRecipeFiles(baseline, project, lock, project);
    const helper = bundledRecipes.recipes[1]!;
    const helperProject = await NodeFSP.readFile(
      NodePath.join(specDirectory, "matlab-connection/pyproject.toml"),
      "utf8",
    );
    const helperLock = await NodeFSP.readFile(
      NodePath.join(specDirectory, "matlab-connection/uv.lock"),
      "utf8",
    );
    validateRecipeFiles(helper, helperProject, helperLock, helperProject);
  });
  it("derives metadata deterministically and rejects changed content without a newer revision", () => {
    expect(sealComputeRecipe(baseline, project, lock, baseline.revision + 1)).toEqual(baseline);
    expect(() => sealComputeRecipe(baseline, `${project}\n`, lock, baseline.revision)).toThrow(
      "newer revision",
    );
    expect(
      sealComputeRecipe(baseline, `${project}\n`, lock, baseline.revision + 1).projectSha256,
    ).toBe(recipeHash(`${project}\n`));
  });
  it.each([
    ["integrity", (value: string) => value, (value: string) => `${value}\n`, false],
    [
      "package membership",
      (value: string) => value.replace("pypdf==", "other-package=="),
      (value: string) => value,
      true,
    ],
    [
      "tool configuration",
      (value: string) => `${value}\n[tool.uv.sources]\npandas = { path = '/tmp/code' }\n`,
      (value: string) => value,
      true,
    ],
    [
      "artifact authority",
      (value: string) => value,
      (value: string) => value.replaceAll("files.pythonhosted.org", "example.com"),
      true,
    ],
    [
      "registry authority",
      (value: string) => value,
      (value: string) => value.replaceAll("https://pypi.org/simple", "https://example.com/simple"),
      true,
    ],
  ])("rejects invalid %s", (_name, changeProject, changeLock, rehash) => {
    const changedProject = changeProject(project);
    const changedLock = changeLock(lock);
    expect(() =>
      validateRecipeFiles(
        {
          ...baseline,
          ...(rehash
            ? { projectSha256: recipeHash(changedProject), lockSha256: recipeHash(changedLock) }
            : {}),
        },
        changedProject,
        changedLock,
        project,
      ),
    ).toThrow();
  });
  it("rejects unknown contracts and revision replacement", () => {
    expect(() =>
      decodeCatalog({
        ...feed(),
        recipes: [{ ...candidate(), contract: 2 }],
      }),
    ).toThrow();
    const current = mergeComputeCatalog(bundledRecipes, feed());
    expect(() =>
      mergeComputeCatalog(current, {
        ...feed(),
        sequence: 3,
        recipes: [{ ...candidate(), pythonVersion: "3.99.99" }],
      }),
    ).toThrow("cannot be replaced");
    expect(mergeComputeCatalog(current, bundledRecipes)).toBe(current);
  });
  it("installs the latest compatible recipe and deduplicates requests", async () => {
    const request = requestFor();
    const catalog = source(request);
    await Promise.all(Array.from({ length: 30 }, () => catalog.refresh()));
    expect(request).toHaveBeenCalledTimes(1);
    const prepared = await catalog.prepare("install", null, new AbortController().signal);
    expect(prepared.recipe.revision).toBe(candidate().revision);
    expect(request).toHaveBeenCalledTimes(4);
    expect(await NodeFSP.readFile(NodePath.join(prepared.specDirectory, "uv.lock"), "utf8")).toBe(
      lock,
    );
    await catalog.prepare("install", null, new AbortController().signal);
    expect(request).toHaveBeenCalledTimes(5);
  });
  it("retains last-good state across failed refresh and process restart", async () => {
    const catalog = source(requestFor());
    await catalog.refresh();
    const restarted = source(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await restarted.refresh();
    expect(restarted.latest()?.revision).toBe(candidate().revision);
    expect(restarted.state()).toBe("unavailable");
  });
  it("uses bundled metadata offline and never claims a current check", async () => {
    const request = vi.fn(async () => {
      throw new Error("offline");
    });
    const catalog = source(request);
    await catalog.refresh();
    await catalog.refresh();
    expect(request).toHaveBeenCalledTimes(1);
    expect(catalog.state()).toBe("unavailable");
    expect(
      (await catalog.prepare("install", null, new AbortController().signal)).recipe.revision,
    ).toBe(baseline.revision);
  });
  it("falls back to shipped files for a first offline install, but never for Update", async () => {
    const known = source(requestFor());
    await known.refresh();
    const offline = source(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(
      (await offline.prepare("install", null, new AbortController().signal)).recipe.revision,
    ).toBe(baseline.revision);
    await expect(
      offline.prepare("update", installed(baseline), new AbortController().signal),
    ).rejects.toThrow("unavailable");
  });
  it("does not advertise a recipe that changes the app's capability set", async () => {
    const catalog = source(
      requestFor({ ...feed(), recipes: [{ ...candidate(), capabilitySha256: "f".repeat(64) }] }),
    );
    await catalog.refresh();
    expect(catalog.latest()?.revision).toBe(baseline.revision);
  });
  it("treats an interrupted response body as unavailable, not a valid new recipe", async () => {
    const catalog = source(async (url) =>
      url === COMPUTE_CATALOG_URL
        ? new Response(JSON.stringify(feed()))
        : new Response(
            new ReadableStream({
              start: (controller) => controller.error(new Error("connection lost")),
            }),
          ),
    );
    expect((await catalog.prepare("install", null, new AbortController().signal)).recipe).toEqual(
      baseline,
    );
    await expect(
      catalog.prepare("update", installed(baseline), new AbortController().signal),
    ).rejects.toThrow("interrupted");
  });
  it("keeps independent MATLAB compatibility and bundled fallback", async () => {
    const helper = bundledRecipes.recipes[1]!;
    const request = requestFor({
      ...feed(),
      recipes: [
        {
          ...helper,
          revision: helper.revision + 1,
          sourceCommit: "b".repeat(40),
          pythonVersion: "3.99.99",
        },
      ],
    });
    const catalog = makeComputeRecipeSource({
      computeDir: root,
      specDirectory: NodePath.join(specDirectory, "matlab-connection"),
      purpose: "matlab-connection",
      target: "darwin-arm64",
      fetch: request,
    });
    sources.push(catalog);
    await catalog.refresh();
    expect(catalog.latest()).toEqual(helper);
  });
  it("rejects new code even if the new hash is advertised", async () => {
    const changed = `${project}\n[tool.uv.sources]\nnumpy = { path = '/tmp/code' }\n`;
    const advertised = { ...candidate(), projectSha256: recipeHash(changed) };
    const request = requestFor({ ...feed(), recipes: [advertised] });
    project = changed;
    const catalog = source(request);
    await expect(catalog.prepare("install", null, new AbortController().signal)).rejects.toThrow();
  });
  it("filters unsupported platforms and incompatible installers", async () => {
    const unsupported = source(requestFor(), "win32-arm64");
    await unsupported.refresh();
    expect(unsupported.latest()?.revision).toBe(baseline.revision);
    const incompatible = source(
      requestFor({
        ...feed(),
        sequence: 3,
        recipes: [{ ...candidate(), revision: baseline.revision + 2, uvVersion: "999.0.0" }],
        withdrawn: [recipeIdentity(candidate())],
      }),
    );
    await incompatible.refresh();
    expect(incompatible.latest()?.revision).toBe(baseline.revision);
  });
  it("pinned repair and Toolkit changes use the installed snapshot without catalog access", async () => {
    const current = installed(baseline);
    const path = NodePath.join(root, "generation-old/project");
    await NodeFSP.mkdir(path, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(path, "pyproject.toml"), project);
    await NodeFSP.writeFile(NodePath.join(path, "uv.lock"), lock);
    const request = requestFor();
    const catalog = source(request);
    for (const action of ["repair", "toolkits"] as const) {
      const result = await catalog.prepare(action, current, new AbortController().signal);
      expect(result.recipe.revision).toBe(baseline.revision);
      expect(result.specDirectory).toBe(path);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses downgrade and withdrawn repair without breaking discovery", async () => {
    const catalog = source(requestFor({ ...feed(), withdrawn: [recipeIdentity(candidate())] }));
    await catalog.refresh();
    expect(catalog.latest()?.revision).toBe(baseline.revision);
    await expect(
      catalog.prepare("repair", installed(), new AbortController().signal),
    ).rejects.toThrow("withdrawn");
    await expect(
      catalog.prepare("update", installed(), new AbortController().signal),
    ).rejects.toThrow("downgrade");
  });
  it("honors persisted withdrawal before the first status refresh", async () => {
    const known = source(requestFor({ ...feed(), withdrawn: [recipeIdentity(baseline)] }));
    await known.refresh();
    const request = requestFor();
    const restarted = source(request);
    await expect(
      restarted.prepare("repair", installed(baseline), new AbortController().signal),
    ).rejects.toThrow("withdrawn");
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds history without evicting the other runtime's latest release", () => {
    const current = mergeComputeCatalog(bundledRecipes, {
      ...feed(),
      recipes: Array.from({ length: 64 }, (_, index) => ({
        ...candidate(),
        revision: baseline.revision + index + 1,
      })),
    });
    expect(current.recipes.filter((entry) => entry.purpose === "python")).toHaveLength(32);
    expect(current.recipes.find((entry) => entry.purpose === "matlab-connection")).toEqual(
      bundledRecipes.recipes[1],
    );
  });
  it("preserves the last good catalog when a body is malformed or oversized", async () => {
    let body = JSON.stringify(feed());
    const catalog = source(vi.fn(async () => new Response(body)));
    await catalog.refresh();
    for (const invalid of ["{broken", "x".repeat(4 * 1024 * 1024 + 1)]) {
      clock += 3_600_001;
      body = invalid;
      await catalog.refresh();
      expect(catalog.latest()?.revision).toBe(candidate().revision);
      expect(catalog.state()).toBe("unavailable");
    }
  });
  it("handles 304 without losing the cached recipe", async () => {
    const request = requestFor()
      .mockResolvedValueOnce(new Response(JSON.stringify(feed()), { headers: { etag: "v2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const catalog = source(request);
    await catalog.refresh();
    clock += 3_600_001;
    await catalog.refresh();
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({ "If-None-Match": "v2" });
    expect(catalog.latest()?.revision).toBe(candidate().revision);
  });
  it("does not materialize a cancelled request", async () => {
    const catalog = source(requestFor());
    const abort = new AbortController();
    abort.abort();
    await expect(catalog.prepare("install", null, abort.signal)).rejects.toThrow();
    expect(await NodeFSP.readdir(root)).not.toContain(recipeIdentity(candidate()));
  });
  it("cancels immediately while a shared check remains in flight", async () => {
    let finish!: (response: Response) => void;
    const catalog = source(
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const refresh = catalog.refresh();
    const abort = new AbortController();
    const preparation = catalog.prepare("install", null, abort.signal);
    abort.abort(new Error("cancelled now"));
    await expect(preparation).rejects.toThrow("cancelled now");
    expect(catalog.state()).toBe("checking");
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish(new Response(JSON.stringify(feed())));
    await refresh;
    expect(catalog.latest()?.revision).toBe(candidate().revision);
  });
});
