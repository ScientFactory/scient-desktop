import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { BROWSER_IMPORT_SOURCES } from "../../preview/BrowserImport/Sources.ts";
import { discoverSourceProfiles } from "./sourceProfiles.ts";

vi.mock("electron", () => ({ nativeImage: {} }));

it.effect("discovers only source metadata without opening a source cookie database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient-accounts-source-" });
    const root = path.join(home, "browser");
    yield* fs.makeDirectory(path.join(root, "Default", "Network"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: {
              name: "Work",
              user_name: "person@example.test",
              gaia_picture_file_name: "../outside.png",
            },
          },
        },
      }),
    );
    yield* fs.writeFileString(
      path.join(root, "Default", "Network", "Cookies"),
      "synthetic cookie store",
    );
    using _sqlite = vi.spyOn(NodeSqliteClient, "layer").mockImplementation(() => {
      throw new Error("Source cookie database was opened during metadata discovery.");
    });
    const definition = { ...BROWSER_IMPORT_SOURCES[0]!, userDataDirectory: () => root };
    const result = yield* discoverSourceProfiles([definition], {
      path,
      home,
      platform: "darwin",
      appData: undefined,
      localAppData: undefined,
    });
    expect(result).toEqual([
      { sourceId: "chrome", directory: "Default", name: "Work", email: "person@example.test" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
