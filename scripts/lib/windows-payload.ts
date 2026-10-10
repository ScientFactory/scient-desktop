/** Pinned loose inventories: whisper.cpp v1.9.1 and Cursor SDK 1.0.35. */
export const WINDOWS_VOICE_FILES = [
  "whisper-server.exe",
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
  "ggml.dll",
  "whisper.dll",
  "parakeet.dll",
  "SDL2.dll",
  "LICENSE.whisper.cpp",
  "provenance.json",
] as const;

export function windowsCursorFiles(arch: "x64" | "arm64") {
  return ["win32", "linux"].flatMap((platform) => {
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
    ...(linuxBackend
      ? [
          `**/node_modules/node-pty/prebuilds/linux-${otherArch}`,
          `**/node_modules/**/*-linux-${otherArch}*`,
        ]
      : ["**/node_modules/node-pty/prebuilds/linux-*", "**/node_modules/**/*-linux-*"]),
  ];
  return roots.flatMap((root) => [root, `${root}/**`]);
}

export function unexpectedWindowsNativeFiles(files: readonly string[], arch: "x64" | "arm64") {
  return files.filter((file) => {
    // Both the native filenames and package/prebuild directory names encode
    // the target. Linux is valid only in the server/WSL and Cursor resources.
    const targets = file.matchAll(
      /(?:^|[/.-])(darwin|linux|win32|android|freebsd)-(x64|arm64|ia32|arm|riscv64|ppc64|s390x)(?=[/.-]|$)/g,
    );
    for (const target of targets) {
      const [, os, cpu] = target;
      if (cpu !== arch || (os !== "win32" && os !== "linux")) return true;
      if (
        os === "linux" &&
        !file.startsWith("resources/server.asar.unpacked/") &&
        !file.startsWith("resources/node_modules/@cursor/sdk-linux-")
      )
        return true;
    }
    const conpty = /\/win10-(x64|arm64)(?:\/|$)/.exec(file);
    return conpty !== null && conpty[1] !== arch;
  });
}

/** Validate known components before subtracting them from the core budget. */
export function analyzeWindowsPayloadInventory(input: {
  readonly files: readonly string[];
  readonly arch: "x64" | "arm64";
  readonly previewFiles?: readonly string[];
}) {
  const components = [
    { name: "voice", root: "resources/whisper-runtime/", files: WINDOWS_VOICE_FILES },
    {
      name: "cursor",
      root: "resources/node_modules/@cursor/",
      files: windowsCursorFiles(input.arch),
    },
    { name: "preview", root: "resources/conversation-preview/", files: input.previewFiles ?? [] },
  ];
  const missingFiles: string[] = [];
  const unexpectedFiles: string[] = unexpectedWindowsNativeFiles(input.files, input.arch);
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
