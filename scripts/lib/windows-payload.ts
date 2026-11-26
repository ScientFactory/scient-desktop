/** Pinned loose inventories: Cursor SDK 1.0.35. */
export const WINDOWS_SERVER_COMPILE_CACHE_ROOT = "resources/server-compile-cache/";
export const WINDOWS_SERVER_COMPILE_CACHE_FILE_LIMIT = 64;

/** T3's transcribe.cpp 0.4.1 engine; it ships a Windows build for x64 only. */
export function windowsTranscribeFiles(arch: "x64" | "arm64") {
  if (arch !== "x64") return [];
  return [
    "ggml-base.dll",
    ...[
      "alderlake",
      "cannonlake",
      "cascadelake",
      "haswell",
      "icelake",
      "sandybridge",
      "skylakex",
      "sse42",
      "x64",
    ].map((cpu) => `ggml-cpu-${cpu}.dll`),
    "ggml-vulkan.dll",
    "ggml.dll",
    "transcribe.dll",
  ];
}

export function windowsCursorFiles(arch: "x64" | "arm64", linuxBackend = true) {
  const platforms = linuxBackend ? (["win32", "linux"] as const) : (["win32"] as const);
  return platforms.flatMap((platform) => {
    const prefix = `sdk-${platform}-${arch}/`;
    const executableSuffix = platform === "win32" ? ".exe" : "";
    return [
      `bin/cursorsandbox${executableSuffix}`,
      `bin/rg${executableSuffix}`,
      "package.json",
      "README.md",
      "vendor/tree-sitter/binding.node",
      "vendor/tree-sitter/index.js",
      "vendor/tree-sitter/package.json",
      "vendor/tree-sitter-bash/binding.node",
      "vendor/tree-sitter-bash/index.js",
      "vendor/tree-sitter-bash/node-types.json",
      "vendor/tree-sitter-bash/package.json",
    ].map((file) => prefix + file);
  });
}

// pnpm's architecture selection cannot remove foreign prebuilds inside a
// package, or ffi-rs ia32 whose package metadata also declares cpu: x64.
export function windowsNativeIgnoreGlobs(arch: "x64" | "arm64", linuxBackend: boolean) {
  const otherArch = arch === "x64" ? "arm64" : "x64";
  const roots = [
    "**/node_modules/node-pty/prebuilds/darwin-*",
    `**/node_modules/node-pty/prebuilds/win32-${otherArch}`,
    "**/node_modules/node-pty/prebuilds/win32-ia32",
    `**/node_modules/node-pty/third_party/conpty/*/win10-${otherArch}`,
    "**/node_modules/**/*-darwin-*",
    "**/node_modules/**/*-android-*",
    "**/node_modules/**/*-freebsd-*",
    "**/node_modules/**/*-win32-ia32-*",
    `**/node_modules/**/*-win32-${otherArch}*`,
    // The Windows backend transcribes on Windows only; WSL ships its own runtime archive.
    "**/node_modules/@transcribe-cpp/linux-*",
    ...(linuxBackend
      ? [
          `**/node_modules/node-pty/prebuilds/linux-${otherArch}`,
          `**/node_modules/*-linux-${otherArch}*`,
          `**/node_modules/@*/*-linux-${otherArch}*`,
        ]
      : [
          "**/node_modules/node-pty/prebuilds/linux-*",
          "**/node_modules/*-linux-*",
          "**/node_modules/@*/*-linux-*",
        ]),
  ];
  return roots.flatMap((root) => [root, `${root}/**`]);
}

export function unexpectedWindowsNativeFiles(
  files: readonly string[],
  arch: "x64" | "arm64",
  linuxBackend = true,
) {
  return files.filter((file) => {
    // Both the native filenames and package/prebuild directory names encode
    // the target. Linux is valid only in the server/WSL and Cursor resources when WSL is bundled.
    const targets = file.matchAll(
      /(?:^|[/.-])(darwin|linux|win32|android|freebsd)-(x64|arm64|ia32|arm|riscv64|ppc64|s390x)(?=[/.-]|$)/g,
    );
    for (const target of targets) {
      const [, os, cpu] = target;
      if (cpu !== arch || (os !== "win32" && os !== "linux")) return true;
      if (os === "linux") {
        if (!linuxBackend) return true;
        if (
          !file.startsWith("resources/server.asar.unpacked/") &&
          !file.startsWith("resources/node_modules/@cursor/sdk-linux-")
        )
          return true;
      }
    }
    const conpty = /\/win10-(x64|arm64)(?:\/|$)/.exec(file);
    return conpty !== null && conpty[1] !== arch;
  });
}

// SCIENT-FORK:START — verify server.asar entries directly so foreign Linux packages cannot hide inside ASAR.
const ASAR_TARGET_PATTERN =
  /(?:^|[/._-])(darwin|linux|win32|android|freebsd)[-_](x64|arm64|ia32|arm|riscv64|ppc64|s390x)(?=[/._-]|$)/g;
const NATIVE_BINARY_EXT = /\.(?:node|so(?:\.\d+)*|dylib|dll|exe)$/i;

function isTargetAllowedInWindowsAsar(
  os: string,
  cpu: string,
  arch: "x64" | "arm64",
  linuxBackend: boolean,
): boolean {
  if (cpu !== arch) return false;
  if (os === "win32") return true;
  return os === "linux" && linuxBackend;
}

export function unexpectedWindowsServerAsarEntries(
  entries: readonly string[],
  arch: "x64" | "arm64",
  linuxBackend: boolean,
) {
  return entries.filter((entry) => {
    const normalized = entry.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!linuxBackend && normalized.startsWith("apps/server/dist/synctex-runtime/linux-")) {
      return true;
    }
    if (!normalized.startsWith("node_modules/")) return false;
    const parts = normalized.split("/");
    const packageRoot = parts[1]?.startsWith("@")
      ? `${parts[1]}/${parts[2] ?? ""}`
      : (parts[1] ?? "");
    const inspectTargets = (segment: string) => {
      for (const match of segment.matchAll(ASAR_TARGET_PATTERN)) {
        const [, os = "", cpu = ""] = match;
        if (!isTargetAllowedInWindowsAsar(os, cpu, arch, linuxBackend)) return true;
      }
      return false;
    };
    if (inspectTargets(packageRoot)) return true;
    const prebuildsIndex = parts.indexOf("prebuilds");
    if (
      prebuildsIndex !== -1 &&
      parts[prebuildsIndex + 1] &&
      inspectTargets(parts[prebuildsIndex + 1]!)
    ) {
      return true;
    }
    if (NATIVE_BINARY_EXT.test(normalized) && inspectTargets(normalized)) {
      return true;
    }
    return false;
  });
}
// SCIENT-FORK:END

/** Validate known components before subtracting them from the core budget. */
export function analyzeWindowsPayloadInventory(input: {
  readonly files: readonly string[];
  readonly arch: "x64" | "arm64";
  readonly previewFiles?: readonly string[];
  readonly linuxBackend?: boolean;
}) {
  const linuxBackend = input.linuxBackend ?? true;
  const components = [
    {
      name: "cursor",
      root: "resources/node_modules/@cursor/",
      files: windowsCursorFiles(input.arch, linuxBackend),
    },
    { name: "preview", root: "resources/conversation-preview/", files: input.previewFiles ?? [] },
    {
      name: "transcribe",
      root: "resources/server.asar.unpacked/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan/",
      files: windowsTranscribeFiles(input.arch),
    },
  ];
  const missingFiles: string[] = [];
  const unexpectedFiles: string[] = unexpectedWindowsNativeFiles(
    input.files,
    input.arch,
    linuxBackend,
  );
  const counts: Record<string, number> = {};
  let allowance = 0;
  const present = new Set(input.files);
  for (const component of components) {
    const expected = new Set(component.files.map((file) => component.root + file));
    const actual = input.files.filter((file) => file.startsWith(component.root));
    missingFiles.push(...[...expected].filter((file) => !present.has(file)));
    unexpectedFiles.push(...actual.filter((file) => !expected.has(file)));
    counts[component.name] = actual.length;
    allowance += expected.size;
  }
  // SCIENT-FORK:START — the server's V8 compile cache holds one small entry per cached module and
  // grows as upstream caches more of startup, so it counts apart from the core budget, up to a cap.
  const compileCache = input.files.filter((file) =>
    file.startsWith(WINDOWS_SERVER_COMPILE_CACHE_ROOT),
  ).length;
  if (compileCache > 0) {
    counts.compileCache = compileCache;
    allowance += Math.min(compileCache, WINDOWS_SERVER_COMPILE_CACHE_FILE_LIMIT);
  }
  // SCIENT-FORK:END
  counts.core =
    input.files.length - Object.values(counts).reduce((total, count) => total + count, 0);
  const breakdown = Object.entries(counts)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  return {
    allowance,
    counts,
    breakdown,
    missingFiles,
    unexpectedFiles: [...new Set(unexpectedFiles)].sort(),
  };
}
