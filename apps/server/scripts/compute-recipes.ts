// @effect-diagnostics nodeBuiltinImport:off -- build metadata CLI, not a runtime service.
/** Build/CI metadata only. Never installs packages or writes an installed app profile. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import {
  ComputeRecipeCatalog,
  recipeHash,
  sealComputeRecipe,
  validateRecipeFiles,
} from "../src/scient/compute/ComputeRecipe.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const directory = NodePath.join(root, "apps/server/src/scient/compute/managed-python");
const metadataPath = NodePath.join(directory, "bundled-recipes.json");
const mode = process.argv[2] ?? "check";
if (!["check", "seal", "catalog"].includes(mode)) throw new Error("Use check, seal, or catalog.");
const originalCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ComputeRecipeCatalog))(
  await NodeFSP.readFile(metadataPath, "utf8"),
);
const revision = Number(
  NodeChildProcess.execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
);
const sourceCommit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const recipes = await Promise.all(
  originalCatalog.recipes.map(async (original) => {
    const path =
      original.purpose === "python" ? directory : NodePath.join(directory, "matlab-connection");
    const project = await NodeFSP.readFile(NodePath.join(path, "pyproject.toml"), "utf8");
    const lock = await NodeFSP.readFile(NodePath.join(path, "uv.lock"), "utf8");
    if (mode === "catalog")
      NodeChildProcess.execFileSync(
        "git",
        [
          "diff",
          "--exit-code",
          "HEAD",
          "--",
          NodePath.join(path, "pyproject.toml"),
          NodePath.join(path, "uv.lock"),
        ],
        { cwd: root, stdio: "pipe" },
      );
    if (
      mode !== "check" &&
      (recipeHash(project) !== original.projectSha256 ||
        recipeHash(lock) !== original.lockSha256) &&
      NodeChildProcess.execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: root,
        encoding: "utf8",
      }).trim() === "true"
    )
      throw new Error(
        "Sealing changed Compute recipes requires full Git history. Fetch history before building this candidate.",
      );
    // Unrelated commits must not turn identical environments into new releases.
    const contentRevision = Number(
      NodeChildProcess.execFileSync(
        "git",
        [
          "log",
          "-1",
          "--format=%ct",
          "--",
          NodePath.join(path, "pyproject.toml"),
          NodePath.join(path, "uv.lock"),
        ],
        { cwd: root, encoding: "utf8" },
      ).trim(),
    );
    const sealed =
      mode === "check" ? original : sealComputeRecipe(original, project, lock, contentRevision);
    validateRecipeFiles(sealed, project, lock, project);
    return sealed;
  }),
);
const catalog = { ...originalCatalog, recipes };
if (mode === "seal" && JSON.stringify(catalog) !== JSON.stringify(originalCatalog))
  await NodeFSP.writeFile(metadataPath, `${JSON.stringify(catalog, null, 2)}\n`);
if (mode === "catalog") {
  const purpose = process.argv[3];
  if (!catalog.recipes.some((recipe) => recipe.purpose === purpose))
    throw new Error("Choose python or matlab-connection.");
  // The publisher merges only the purpose actually qualified by this run.
  process.stdout.write(
    `${JSON.stringify(
      {
        ...catalog,
        sequence: revision,
        recipes: catalog.recipes
          .filter((recipe) => recipe.purpose === purpose)
          .map((recipe) => ({ ...recipe, sourceCommit })),
      },
      null,
      2,
    )}\n`,
  );
}
