// FILE: notificationRouting.test.ts
// Purpose: Prevents feature code from bypassing the typed notification routing policy.
// Layer: Architecture guard test

import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RAW_MANAGER_ALLOWLIST = new Set([
  "components/ui/toast.tsx",
  "notifications/transientAlert.ts",
]);

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (/\.(?:browser|test)\.[jt]sx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("notification routing architecture", () => {
  it("keeps raw toast managers behind the transient-alert adapter and renderer", () => {
    const bypasses = productionSourceFiles(SOURCE_ROOT).flatMap((path) => {
      const relativePath = relative(SOURCE_ROOT, path);
      if (RAW_MANAGER_ALLOWLIST.has(relativePath)) return [];
      const source = readFileSync(path, "utf8");
      return /\b(?:anchoredToastManager|toastManager)\s*\./.test(source) ? [relativePath] : [];
    });

    expect(bypasses).toEqual([]);
  });
});
