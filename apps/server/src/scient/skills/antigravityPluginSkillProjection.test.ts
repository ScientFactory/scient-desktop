import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { prepareAntigravityProfile } from "../../provider/antigravityAuthSupport.ts";
import {
  projectAntigravityPluginSkills,
  linkAntigravityUserPlugins,
} from "./antigravityPluginSkillProjection.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeHome = Effect.fn("test.makeAntigravityPluginHome")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-agy-projection-" });
  const userHome = path.join(root, "home");
  const profileDirectory = path.join(root, "profile");
  const plugins = path.join(userHome, ".gemini", "config", "plugins");
  for (const name of ["science", "gmail"]) {
    yield* fs.makeDirectory(path.join(plugins, name, "skills", `${name}-skill`), {
      recursive: true,
    });
    yield* fs.writeFileString(path.join(plugins, name, "plugin.json"), encodeJson({ name }));
  }
  return { root, userHome, profileDirectory, plugins };
});

it.layer(NodeServices.layer)("Antigravity plugin skill projection", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "leaves out plugins `agy plugin disable` turned off, and all of them when its switches are unreadable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeHome();
        const config = path.join(home.userHome, ".gemini", "config", "config.json");
        const projected = (name: string) =>
          fs.exists(path.join(home.profileDirectory, "config", "plugins", name, "skills"));
        const project = projectAntigravityPluginSkills({
          profileDirectory: home.profileDirectory,
          userHome: home.userHome,
          platform: yield* HostProcess.Platform,
        });

        yield* fs.writeFileString(config, encodeJson({ plugins: { gmail: { enabled: false } } }));
        yield* project;
        expect(yield* projected("science")).toBe(true);
        expect(yield* projected("gmail")).toBe(false);

        yield* fs.writeFileString(config, `{"pad":"${"x".repeat(1_000_000)}"}`);
        yield* project;
        expect(yield* projected("science")).toBe(false);

        yield* fs.remove(config);
        yield* project;
        expect(yield* projected("science")).toBe(true);
        expect(yield* projected("gmail")).toBe(true);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "links the agy CLI's profile to the user's own plugins, replacing only Scient's link",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeHome();
        const pluginsLink = path.join(home.profileDirectory, "config", "plugins");
        const isLink = fs.readLink(pluginsLink).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

        yield* prepareAntigravityProfile({
          profileDirectory: home.profileDirectory,
          userHome: home.userHome,
        });
        expect(yield* isLink).toBe(true);
        const generation = yield* fs.readLink(pluginsLink);

        // agy --gemini-dir reads plugins and their sign-ins from the profile.
        yield* prepareAntigravityProfile({
          profileDirectory: home.profileDirectory,
          userHome: home.userHome,
          nativePlugins: true,
        });
        expect(yield* fs.readLink(pluginsLink)).toBe(home.plugins);
        expect(yield* fs.exists(path.join(pluginsLink, "gmail", "plugin.json"))).toBe(true);
        // A paired session that is still running keeps reading its generation.
        expect(yield* fs.exists(path.join(generation, "science", "skills"))).toBe(true);

        const link = linkAntigravityUserPlugins({
          profileDirectory: home.profileDirectory,
          userHome: home.userHome,
          platform: yield* HostProcess.Platform,
        });
        // Someone else's link and a real folder stay as they are.
        const elsewhere = path.join(home.root, "elsewhere");
        yield* fs.makeDirectory(elsewhere);
        yield* fs.remove(pluginsLink);
        yield* fs.symlink(elsewhere, pluginsLink);
        yield* link;
        expect(yield* fs.readLink(pluginsLink)).toBe(elsewhere);
        yield* fs.remove(pluginsLink);
        yield* fs.makeDirectory(path.join(pluginsLink, "own-plugin"), { recursive: true });
        yield* link;
        expect(yield* fs.exists(path.join(pluginsLink, "own-plugin"))).toBe(true);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "copies the user's plugin switches into the profile beside Scient's own",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeHome();
        const profileConfig = path.join(home.profileDirectory, "config", "config.json");
        yield* fs.makeDirectory(path.dirname(profileConfig), { recursive: true });
        yield* fs.writeFileString(
          profileConfig,
          encodeJson({ plugins: { swarm: { enabled: false } } }),
        );
        yield* fs.writeFileString(
          path.join(home.userHome, ".gemini", "config", "config.json"),
          encodeJson({
            plugins: { gmail: { enabled: false }, science: { installedFrom: { id: "x" } } },
          }),
        );
        yield* linkAntigravityUserPlugins({
          profileDirectory: home.profileDirectory,
          userHome: home.userHome,
          platform: yield* HostProcess.Platform,
        });
        expect(yield* decodeJson(yield* fs.readFileString(profileConfig))).toEqual({
          plugins: { swarm: { enabled: false }, gmail: { enabled: false } },
        });
      }),
  );
});
