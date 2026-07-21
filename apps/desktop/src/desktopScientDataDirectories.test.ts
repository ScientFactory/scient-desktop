import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRIVATE_DIRECTORY_MODE } from "@synara/shared/privatePathPermissions";
import { afterEach, describe, expect, it } from "vitest";

import { ensurePrivateDesktopScientDataDirectoriesSync } from "./desktopScientDataDirectories";
import { seedScientHomeFromPapiLab } from "./legacyPapiLabHomeMigration";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scient-desktop-private-dirs-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ensurePrivateDesktopScientDataDirectoriesSync", () => {
  it.runIf(process.platform !== "win32")(
    "repairs migrated state before desktop logging can use it",
    () => {
      const container = makeRoot();
      const legacyHome = path.join(container, ".papilab");
      const scientHome = path.join(container, ".scient");
      const legacyLogsDir = path.join(legacyHome, "userdata", "logs");
      fs.mkdirSync(legacyLogsDir, { recursive: true });
      fs.writeFileSync(path.join(legacyLogsDir, "server.log"), "legacy");
      fs.chmodSync(path.join(legacyHome, "userdata"), 0o775);
      fs.chmodSync(legacyLogsDir, 0o775);

      expect(
        seedScientHomeFromPapiLab({ sourcePath: legacyHome, targetPath: scientHome }).status,
      ).toBe("seeded");
      const paths = ensurePrivateDesktopScientDataDirectoriesSync(scientHome);

      expect(fs.readFileSync(path.join(paths.logsDir, "server.log"), "utf8")).toBe("legacy");
      for (const directoryPath of Object.values(paths)) {
        expect(fs.statSync(directoryPath).mode & 0o777, directoryPath).toBe(PRIVATE_DIRECTORY_MODE);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "creates a fresh desktop tree as owner-only under umask 002",
    () => {
      const scientHome = path.join(makeRoot(), ".scient");
      const previousUmask = process.umask(0o002);
      let paths: ReturnType<typeof ensurePrivateDesktopScientDataDirectoriesSync>;
      try {
        paths = ensurePrivateDesktopScientDataDirectoriesSync(scientHome);
      } finally {
        process.umask(previousUmask);
      }

      for (const directoryPath of Object.values(paths)) {
        expect(fs.statSync(directoryPath).mode & 0o777, directoryPath).toBe(PRIVATE_DIRECTORY_MODE);
      }
    },
  );

  it("creates every managed directory with Windows permission semantics", () => {
    const paths = ensurePrivateDesktopScientDataDirectoriesSync(
      path.join(makeRoot(), ".scient"),
      "win32",
    );

    for (const directoryPath of Object.values(paths)) {
      expect(fs.statSync(directoryPath).isDirectory(), directoryPath).toBe(true);
    }
  });
});
