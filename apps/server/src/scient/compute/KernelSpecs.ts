// @effect-diagnostics nodeBuiltinImport:off -- private kernel folders are named by a hash of the path.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { pathModule, type DiscoveryContext } from "./RuntimeDiscovery.ts";

const MAX_KERNELS = 64;

const KernelJson = Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  display_name: Schema.String,
  language: Schema.NonEmptyString,
  interrupt_mode: Schema.optional(Schema.Literals(["signal", "message"])),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeKernelJson = Schema.decodeUnknownOption(Schema.fromJsonString(KernelJson));

/** One installed kernel; its directory is its identity, so two `python3` specs never merge. */
export interface InstalledKernelSpec {
  readonly name: string;
  readonly resourceDir: string;
  readonly displayName: string;
  readonly language: string;
  readonly argv: ReadonlyArray<string>;
  readonly interruptMode: "signal" | "message";
  readonly env: Readonly<Record<string, string>>;
}

/** Jupyter's search order: JUPYTER_PATH, the user's data directory, environment prefixes, system. */
export function jupyterKernelDirectories(
  context: DiscoveryContext,
  prefixes: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const path = pathModule(context.platform);
  const env = context.environment;
  const home = context.homeDirectory;
  const user =
    env.JUPYTER_DATA_DIR ??
    (context.platform === "darwin"
      ? path.join(home, "Library", "Jupyter")
      : context.platform === "win32"
        ? path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "jupyter")
        : path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "jupyter"));
  const system =
    context.platform === "win32"
      ? [path.join(env.PROGRAMDATA ?? "C:\\ProgramData", "jupyter")]
      : ["/usr/local/share/jupyter", "/usr/share/jupyter"];
  return [
    ...(env.JUPYTER_PATH ?? "")
      .split(context.platform === "win32" ? ";" : ":")
      .filter((entry) => entry.length > 0),
    user,
    ...prefixes.map((prefix) => path.join(prefix, "share", "jupyter")),
    ...system,
  ].map((directory) => path.join(directory, "kernels"));
}

/** Reads kernel.json files only; nothing is launched. */
export function readInstalledKernelSpecs(
  context: DiscoveryContext,
  directories: ReadonlyArray<string>,
): ReadonlyArray<InstalledKernelSpec> {
  const path = pathModule(context.platform);
  const seen = new Set<string>();
  const specs: InstalledKernelSpec[] = [];
  for (const directory of directories) {
    for (const name of context.host.readDirectory(directory).toSorted()) {
      const resourceDir = path.join(directory, name);
      const key = context.platform === "win32" ? resourceDir.toLowerCase() : resourceDir;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = context.host.readText(path.join(resourceDir, "kernel.json"));
      if (text === null) continue;
      const parsed = decodeKernelJson(text);
      if (parsed._tag === "None") continue;
      specs.push({
        name,
        resourceDir,
        displayName: parsed.value.display_name || name,
        language: parsed.value.language,
        argv: parsed.value.argv,
        interruptMode: parsed.value.interrupt_mode ?? "signal",
        env: parsed.value.env ?? {},
      });
      if (specs.length >= MAX_KERNELS) return specs;
    }
  }
  return specs;
}

/**
 * Programs named by kernels of a language. A kernel proves its language only when it starts the
 * language itself: a wrapper kernel starts Python, which says nothing about Octave.
 */
export function kernelPrograms(
  context: DiscoveryContext,
  language: string,
  isLanguage: (programName: string) => boolean,
): ReadonlyArray<{ readonly executable: string; readonly kernel: string }> {
  const path = pathModule(context.platform);
  return readInstalledKernelSpecs(context, jupyterKernelDirectories(context, [])).flatMap(
    (spec) => {
      const [program] = spec.argv;
      return spec.language.toLowerCase() === language.toLowerCase() &&
        program !== undefined &&
        path.isAbsolute(program) &&
        isLanguage(path.basename(program).toLowerCase())
        ? [{ executable: program, kernel: spec.name }]
        : [];
    },
  );
}

/** Keeps a private kernel apart per installation and version, since packages are built for one. */
export function privateKernelDirectory(
  computeDir: string,
  languageId: string,
  realExecutable: string,
  version: string | null,
): string {
  const key = NodeCrypto.createHash("sha256")
    .update([realExecutable, version ?? ""].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return NodePath.join(computeDir, "kernels", languageId, key);
}

/**
 * Starts ipykernel from Scient's folder for a Python that has none, or only an older one. The
 * kernel loads its own dependencies first, then the folder moves behind the person's packages, so
 * their code keeps seeing their versions. Removing the working directory matches ipykernel's own
 * launcher: the kernel restores it, and a project file must not shadow what the kernel imports.
 */
export const PRIVATE_KERNEL_STARTER = [
  "import sys",
  "private = sys.argv.pop(1)",
  'if sys.path[0] == "":',
  "    del sys.path[0]",
  "sys.path.insert(0, private)",
  "from ipykernel import kernelapp",
  "sys.path.remove(private)",
  "sys.path.append(private)",
  "kernelapp.launch_new_instance()",
].join("\n");
