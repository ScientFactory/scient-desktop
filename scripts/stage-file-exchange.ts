// @effect-diagnostics nodeBuiltinImport:off -- Standalone host compiler invocation, no server runtime.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const argumentsByName = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (separator < 0) throw new Error(`Expected --name=value argument: ${argument}`);
    return [argument.slice(0, separator), argument.slice(separator + 1)] as const;
  }),
);
for (const name of argumentsByName.keys()) {
  if (!["--platform", "--arch", "--destination", "--probe"].includes(name))
    throw new Error(`Unknown staging argument: ${name}`);
}
const platform = argumentsByName.get("--platform") ?? HostProcess.Platform.defaultValue();
const arch = argumentsByName.get("--arch") ?? HostProcess.Architecture.defaultValue();
if (!["darwin", "linux", "win32"].includes(platform))
  throw new Error(`Unsupported native platform: ${platform}`);
if (!["x64", "arm64", "universal"].includes(arch))
  throw new Error(`Unsupported native architecture: ${arch}`);
if (platform !== HostProcess.Platform.defaultValue())
  throw new Error(
    "Native helpers must be built on the target OS; no cross-platform artifact substitution.",
  );
if (platform !== "darwin" && arch !== HostProcess.Architecture.defaultValue())
  throw new Error("Use a target-architecture compiler host for Linux/Windows native staging.");
const destination = NodePath.resolve(
  argumentsByName.get("--destination") ??
    NodePath.join(root, "native/file-exchange", `${platform}-${arch}`),
);
const probe = argumentsByName.get("--probe") === "true";
if (argumentsByName.has("--probe") && !["true", "false"].includes(argumentsByName.get("--probe")!))
  throw new Error("--probe must be true or false.");
if (probe && !argumentsByName.has("--destination"))
  throw new Error(
    "Qualification probes require an explicit isolated --destination; never replace the default production helper.",
  );
await NodeFSP.mkdir(destination, { recursive: true });
const scratch = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), "scient-publication-compile-"),
);
try {
  const sources = [
    "publication.c",
    platform === "win32" ? "publication-windows.c" : "publication-posix.c",
  ].map((source) => NodePath.join(root, "native/file-exchange", source));
  const executable = NodePath.join(
    destination,
    platform === "win32" ? "scient-file-publication.exe" : "scient-file-publication",
  );
  if (platform === "win32") {
    NodeChildProcess.execFileSync(
      "cl.exe",
      [
        "/nologo",
        "/O2",
        "/W4",
        "/WX",
        "/guard:cf",
        "/D_CRT_SECURE_NO_WARNINGS",
        ...(probe ? ["/DSCIENT_PUBLICATION_PROBE"] : []),
        `/Fo${scratch}${NodePath.sep}`,
        ...sources,
        "/link",
        `/OUT:${executable}`,
        `/MACHINE:${arch === "arm64" ? "ARM64" : "X64"}`,
        "Advapi32.lib",
      ],
      { stdio: "inherit", cwd: scratch },
    );
  } else {
    const architectureFlags =
      platform === "darwin"
        ? arch === "universal"
          ? ["-arch", "arm64", "-arch", "x86_64"]
          : ["-arch", arch === "x64" ? "x86_64" : "arm64"]
        : [];
    const flags = [
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-fstack-protector-strong",
      ...architectureFlags,
    ];
    NodeChildProcess.execFileSync(
      "cc",
      [...flags, ...(probe ? ["-DSCIENT_PUBLICATION_PROBE"] : []), ...sources, "-o", executable],
      { stdio: "inherit", cwd: scratch },
    );
  }
  await NodeFSP.rm(NodePath.join(destination, "scient-file-exchange"), { force: true });
  await NodeFSP.writeFile(
    NodePath.join(destination, "publication-artifact.json"),
    `${JSON.stringify({ protocol: 1, platform, arch, probe, executable: NodePath.basename(executable) })}\n`,
  );
} finally {
  await NodeFSP.rm(scratch, { recursive: true, force: true });
}
