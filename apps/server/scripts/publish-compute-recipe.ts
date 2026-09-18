// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- bounded trusted CI publication CLI, outside the service runtime.
/** Trusted main-only publication, after native qualification. No dependency installation here. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ComputeRecipeCatalog, recipeIdentity } from "../src/scient/compute/ComputeRecipe.ts";
import { mergeComputeCatalog } from "../src/scient/compute/ComputeRecipeSource.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const repository = "ScientFactory/scient-desktop";
const branch = "automation/compute-recipes-v1";
const purpose = process.argv[2];
const withdrawal = process.argv[3] || undefined;
if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error("Compute publication is restricted to this repository's main branch.");
if (purpose !== "python" && purpose !== "matlab-connection")
  throw new Error("Invalid recipe purpose.");
const token = process.env.GH_TOKEN;
if (!token) throw new Error("A scoped publication token is required.");
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = git("rev-parse", "HEAD");
if (source !== process.env.GITHUB_SHA)
  throw new Error("Publication checkout differs from qualification.");
git("fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
git("merge-base", "--is-ancestor", source, "origin/main");
// Re-run from current main if any runtime, contract, dependency or gate changed.
git(
  "diff",
  "--exit-code",
  source,
  "origin/main",
  "--",
  "apps/server/src",
  "apps/server/scripts",
  "packages/scient-compute",
  "packages/scient-execution",
  "packages/shared",
  "pnpm-lock.yaml",
  "apps/server/package.json",
  ".github/workflows/scient-compute*",
);
const candidate = Schema.decodeUnknownSync(Schema.fromJsonString(ComputeRecipeCatalog))(
  NodeChildProcess.execFileSync(
    process.execPath,
    ["apps/server/scripts/compute-recipes.ts", "catalog", purpose],
    {
      cwd: root,
      encoding: "utf8",
    },
  ),
);
const qualifiedTargets = purpose === "python" ? ["darwin-arm64", "linux-x64"] : ["darwin-arm64"];
if (
  candidate.recipes.some(
    (recipe) => JSON.stringify([...recipe.targets].sort()) !== JSON.stringify(qualifiedTargets),
  )
)
  throw new Error("Recipe targets differ from this workflow's native qualification matrix.");
const api = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`Compute catalog publication failed (${response.status}).`);
  return response.json();
};
const File = Schema.Struct({
  sha: Schema.String,
  content: Schema.String,
  encoding: Schema.Literal("base64"),
});
const raw = await api(`contents/catalog.json?ref=${encodeURIComponent(branch)}`);
const existing = raw === null ? null : Schema.decodeUnknownSync(File)(raw);
const current =
  existing === null
    ? { schemaVersion: 1 as const, sequence: 1, recipes: [], withdrawn: [] }
    : Schema.decodeUnknownSync(Schema.fromJsonString(ComputeRecipeCatalog))(
        Buffer.from(existing.content, "base64").toString("utf8"),
      );
if (
  withdrawal &&
  !current.recipes.some(
    (recipe) => recipe.purpose === purpose && recipeIdentity(recipe) === withdrawal,
  )
)
  throw new Error("Withdrawal must identify an existing recipe of the selected purpose.");
const next = mergeComputeCatalog(current, {
  ...candidate,
  sequence: current.sequence + 1,
  recipes: withdrawal
    ? []
    : candidate.recipes.map(
        (candidate) =>
          current.recipes.find((entry) => recipeIdentity(entry) === recipeIdentity(candidate)) ??
          candidate,
      ),
  withdrawn: withdrawal ? [withdrawal] : [],
});
if (
  JSON.stringify(next.recipes) === JSON.stringify(current.recipes) &&
  JSON.stringify(next.withdrawn) === JSON.stringify(current.withdrawn)
) {
  process.stdout.write("Qualified Compute recipe already published; no change.\n");
} else {
  if (!existing) {
    const ref = await api(`git/ref/heads/${branch}`);
    if (ref === null) await api("git/refs", "POST", { ref: `refs/heads/${branch}`, sha: source });
  }
  // The file SHA is the compare-and-swap guard; concurrent publishers cannot overwrite each other.
  await api("contents/catalog.json", "PUT", {
    branch,
    message: `chore(compute): ${withdrawal ? "withdraw" : "publish qualified"} ${purpose} recipe`,
    content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`).toString("base64"),
    ...(existing ? { sha: existing.sha } : {}),
  });
  const verified = Schema.decodeUnknownSync(File)(
    await api(`contents/catalog.json?ref=${encodeURIComponent(branch)}`),
  );
  if (
    Buffer.from(verified.content, "base64").toString("utf8") !==
    `${JSON.stringify(next, null, 2)}\n`
  )
    throw new Error("Publication readback differs from the qualified catalog.");
  process.stdout.write(`Published ${purpose} from ${source}.\n`);
}
