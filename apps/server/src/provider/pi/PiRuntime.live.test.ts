import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { checkPiProviderStatus } from "../PiProvider.ts";

const binary = process.env.SCIENT_PI_TEST_BINARY;
const decodePiSettings = Schema.decodeSync(PiSettings);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live.skipIf(!binary)(
  "discovers workspace-local skills and templates without executing extensions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-discovery-" });
        const profile = path.join(root, "profile");
        const project = path.join(root, "project");
        yield* fs.makeDirectory(profile);
        // Explicit trust in a synthetic fixture, never a product override.
        yield* fs.writeFileString(
          path.join(profile, "settings.json"),
          json({ defaultProjectTrust: "always" }),
        );
        yield* fs.makeDirectory(path.join(project, ".pi", "skills", "fixture"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(project, ".pi", "prompts"), { recursive: true });
        yield* fs.makeDirectory(path.join(project, ".pi", "extensions"), { recursive: true });
        yield* fs.writeFileString(
          path.join(project, ".pi", "skills", "fixture", "SKILL.md"),
          "---\nname: fixture\ndescription: Synthetic project skill\n---\nDo synthetic work.",
        );
        yield* fs.writeFileString(
          path.join(project, ".pi", "prompts", "fixture-prompt.md"),
          "---\ndescription: Synthetic template\n---\nSynthetic prompt.",
        );
        const marker = path.join(root, "extension-executed");
        yield* fs.writeFileString(
          path.join(project, ".pi", "extensions", "fixture.js"),
          `import fs from 'node:fs'; fs.writeFileSync(${json(marker)}, 'unexpected'); export default function() {}`,
        );
        const settings = decodePiSettings({ enabled: true, binaryPath: binary! });
        const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: profile };
        // SCIENT-FORK:START — the old signature was
        // `checkPiProviderStatus(settings, env, makeRpcClient, cwd)`; these call
        // sites passed `undefined` for the client, so dropping the argument keeps
        // the identical default behaviour against the current upstream signature.
        const workspace = yield* checkPiProviderStatus(settings, env, project);
        // SCIENT-FORK:END
        expect(workspace.skills.some((skill) => skill.name === "fixture")).toBe(true);
        expect(workspace.slashCommands.some((command) => command.name === "fixture-prompt")).toBe(
          true,
        );
        const outside = yield* checkPiProviderStatus(settings, env, root);
        expect(outside.skills.some((skill) => skill.name === "fixture")).toBe(false);
        expect(yield* fs.exists(marker)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
