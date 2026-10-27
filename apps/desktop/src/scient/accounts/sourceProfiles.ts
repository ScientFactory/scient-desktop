import type { DesktopSourceProfileDetails } from "@t3tools/contracts";
import { nativeImage } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  BROWSER_IMPORT_SOURCES,
  listSourceProfiles,
  sourcePathContext,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
} from "../../preview/BrowserImport/Sources.ts";
import { DesktopAccountsError } from "./errors.ts";
import { parseChromiumProfileMetadata } from "./profileMetadata.ts";

const profilePicture = Effect.fn("DesktopAccounts.profilePicture")(function* (
  context: BrowserImportPathContext,
  root: string,
  directory: string,
  file: string | undefined,
) {
  if (file === undefined) return undefined;
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const profile = context.path.join(root, directory);
    const canonicalRoot = yield* fs.realPath(root);
    const canonicalProfile = yield* fs.realPath(profile);
    if (context.path.dirname(canonicalProfile) !== canonicalRoot) return undefined;
    const picture = context.path.join(canonicalProfile, file);
    if ((yield* fs.realPath(picture)) !== picture) return undefined;
    const stat = yield* fs.stat(picture);
    if (stat.type !== "File" || stat.size > 2_000_000n) return undefined;
    const bytes = yield* fs.readFile(picture);
    return yield* Effect.try({
      try: () => {
        const image = nativeImage.createFromBuffer(Buffer.from(bytes));
        if (image.isEmpty()) return undefined;
        const { width, height } = image.getSize();
        const side = Math.min(96, width, height);
        const png = image.resize({ width: side, height: side, quality: "good" }).toPNG();
        return png.length <= 65_536 ? `data:image/png;base64,${png.toString("base64")}` : undefined;
      },
      catch: () => new DesktopAccountsError({}),
    });
  }).pipe(Effect.orElseSucceed(() => undefined));
});

export const discoverSourceProfiles = Effect.fn("DesktopAccounts.sourceProfiles")(function* (
  definitions: ReadonlyArray<BrowserImportSourceDefinition> = BROWSER_IMPORT_SOURCES,
  suppliedContext?: BrowserImportPathContext,
) {
  const context = suppliedContext ?? (yield* sourcePathContext);
  const fs = yield* FileSystem.FileSystem;
  const result: DesktopSourceProfileDetails[] = [];
  for (const definition of definitions) {
    if (!definition.platforms.includes(context.platform)) continue;
    const root = definition.userDataDirectory(context);
    if (root === undefined) continue;
    const profiles = yield* listSourceProfiles(definition, context, false);
    const metadata =
      definition.engine === "chromium"
        ? parseChromiumProfileMetadata(
            yield* fs
              .readFileString(context.path.join(root, "Local State"))
              .pipe(Effect.orElseSucceed(() => "")),
          )
        : [];
    const discovered = new Map(profiles.map((profile) => [profile.directory, profile]));
    for (const info of metadata) discovered.set(info.directory, info);
    for (const profile of discovered.values()) {
      const info = metadata.find((entry) => entry.directory === profile.directory);
      const picture = info
        ? yield* profilePicture(context, root, info.directory, info.pictureFile)
        : undefined;
      result.push({
        sourceId: definition.id,
        directory: profile.directory,
        name: info?.name ?? profile.name,
        ...(info?.email === undefined ? {} : { email: info.email }),
        ...(info?.color === undefined ? {} : { color: info.color }),
        ...(picture === undefined ? {} : { picture }),
      });
    }
  }
  return result;
});
