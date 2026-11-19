import { assert, describe, it } from "@effect/vitest";

import { findForbiddenWslRuntimeArchiveMember } from "./build-desktop-artifact.ts";

describe("Scient WSL runtime archive", () => {
  it("accepts the Linux runtime and the Windows-named sources Linux packages carry", () => {
    assert.isUndefined(
      findForbiddenWslRuntimeArchiveMember([
        "apps/server/dist/bin.mjs",
        "node_modules/@transcribe-cpp/linux-x64-cpu-vulkan/libtranscribe.so",
        "node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
        "node_modules/koffi/src/koffi/src/win32.cc",
        "node_modules/node-pty/lib/windowsPtyAgent.js",
      ]),
    );
  });

  it("refuses Windows-only packages, listed or not", () => {
    for (const member of [
      "node_modules/@transcribe-cpp/win32-x64-cpu-vulkan/ggml-vulkan.dll",
      "node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node",
      "node_modules/@example/addon-win32-x64-msvc/addon.node",
      "node_modules/example-win32-x64/index.node",
    ]) {
      assert.strictEqual(findForbiddenWslRuntimeArchiveMember([member]), member);
    }
  });
});
