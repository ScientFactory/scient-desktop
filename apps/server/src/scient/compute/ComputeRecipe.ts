// @effect-diagnostics nodeBuiltinImport:off -- hashes identify immutable recipe content.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { parse } from "smol-toml";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Version = Schema.String.check(Schema.isPattern(/^3\.\d+\.\d+$/));
export const ComputeRecipe = Schema.Struct({
  purpose: Schema.Literals(["python", "matlab-connection"]),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  toolkitRevision: Schema.String.check(Schema.isPattern(/^[a-z0-9.-]{1,128}$/)),
  contract: Schema.Literal(1),
  pythonVersion: Version,
  uvVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
  sourceCommit: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  projectSha256: Hash,
  lockSha256: Hash,
  capabilitySha256: Hash,
  targets: Schema.Array(
    Schema.Literals([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
      "win32-arm64",
    ]),
  ).check(Schema.isMaxLength(6)),
  summary: Schema.String.check(Schema.isMaxLength(512)),
});
export type ComputeRecipe = typeof ComputeRecipe.Type;
export const ComputeRecipeCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  recipes: Schema.Array(ComputeRecipe).check(Schema.isMaxLength(64)),
  withdrawn: Schema.Array(Hash).check(Schema.isMaxLength(256)),
});
export type ComputeRecipeCatalog = typeof ComputeRecipeCatalog.Type;
export const recipeHash = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
export const recipeIdentity = (recipe: ComputeRecipe): string =>
  recipeHash(
    JSON.stringify([
      recipe.purpose,
      recipe.revision,
      recipe.toolkitRevision,
      recipe.contract,
      recipe.pythonVersion,
      recipe.uvVersion,
      recipe.projectSha256,
      recipe.lockSha256,
      recipe.capabilitySha256,
    ]),
  );

const Project = Schema.Struct({
  project: Schema.Struct({
    name: Schema.String,
    version: Schema.Literal("0.0.0"),
    "requires-python": Schema.String,
    dependencies: Schema.Array(Schema.String),
    "optional-dependencies": Schema.optional(
      Schema.Record(Schema.String, Schema.Array(Schema.String)),
    ),
  }),
  tool: Schema.Struct({ uv: Schema.Struct({ package: Schema.Literal(false) }) }),
});
const decodeProject = Schema.decodeUnknownSync(Project, { onExcessProperty: "error" });
const decodeRecipe = Schema.decodeUnknownSync(ComputeRecipe);
const Source = Schema.Union([
  Schema.Struct({ registry: Schema.Literal("https://pypi.org/simple") }),
  Schema.Struct({ virtual: Schema.Literal(".") }),
]);
const Lock = Schema.Struct({
  package: Schema.Array(
    Schema.Struct({
      source: Schema.Unknown,
      wheels: Schema.optional(
        Schema.Array(Schema.Struct({ url: Schema.String, hash: Schema.String })),
      ),
      sdist: Schema.optional(Schema.Struct({ url: Schema.String, hash: Schema.String })),
    }),
  ),
});
const decodeLock = Schema.decodeUnknownSync(Lock);
const decodeSource = Schema.decodeUnknownSync(Source, { onExcessProperty: "error" });

function recipeCapabilities(project: string): string {
  const parsed = decodeProject(parse(project));
  const names = (dependencies: readonly string[]) =>
    dependencies
      .map((entry) => {
        const match = /^([a-zA-Z0-9_-]+(?:\[[a-zA-Z0-9_,.-]+\])?)==([a-zA-Z0-9.!+_-]+)$/.exec(
          entry,
        );
        if (!match) throw new Error("Compute recipes require exact registry dependencies.");
        return match[1]!.toLowerCase().replaceAll("_", "-");
      })
      .sort();
  return recipeHash(
    JSON.stringify([
      parsed.project.name,
      names(parsed.project.dependencies),
      Object.entries(parsed.project["optional-dependencies"] ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, deps]) => [key, names(deps)]),
    ]),
  );
}

export function sealComputeRecipe(
  baseline: ComputeRecipe,
  project: string,
  lock: string,
  revision: number,
): ComputeRecipe {
  const pythonVersion = decodeProject(parse(project)).project["requires-python"].replace(/^==/, "");
  const projectSha256 = recipeHash(project);
  const lockSha256 = recipeHash(lock);
  const capabilitySha256 = recipeCapabilities(project);
  if (
    baseline.projectSha256 === projectSha256 &&
    baseline.lockSha256 === lockSha256 &&
    baseline.pythonVersion === pythonVersion &&
    baseline.capabilitySha256 === capabilitySha256
  )
    return baseline;
  if (revision <= baseline.revision) throw new Error("A changed recipe requires a newer revision.");
  return decodeRecipe({
    ...baseline,
    revision,
    pythonVersion,
    projectSha256,
    lockSha256,
    capabilitySha256,
    toolkitRevision: `${baseline.purpose === "python" ? "scientific-python" : "matlab-connection"}-${DateTime.formatIso(DateTime.makeUnsafe(revision * 1000)).slice(0, 10)}.${revision}`,
  });
}

/** The feed can change versions, not package membership, indexes, builds or scripts. */
export function validateRecipeFiles(
  recipe: ComputeRecipe,
  project: string,
  lock: string,
  baselineProject: string,
): void {
  if (recipeHash(project) !== recipe.projectSha256 || recipeHash(lock) !== recipe.lockSha256)
    throw new Error("Compute recipe integrity check failed.");
  const candidate = decodeProject(parse(project));
  const baseline = decodeProject(parse(baselineProject));
  if (
    candidate.project.name !== baseline.project.name ||
    candidate.project["requires-python"] !== `==${recipe.pythonVersion}` ||
    recipeCapabilities(project) !== recipe.capabilitySha256 ||
    recipe.capabilitySha256 !== recipeCapabilities(baselineProject)
  )
    throw new Error("Compute recipe requires a different app capability contract.");
  const parsed = decodeLock(parse(lock));
  for (const pkg of parsed.package) {
    decodeSource(pkg.source);
    for (const artifact of [...(pkg.wheels ?? []), ...(pkg.sdist ? [pkg.sdist] : [])]) {
      const url = new URL(artifact.url);
      if (
        url.origin !== "https://files.pythonhosted.org" ||
        url.username ||
        url.password ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.hash)
      )
        throw new Error("Compute recipe contains an unapproved package artifact.");
    }
  }
}
