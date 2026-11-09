// @effect-diagnostics nodeBuiltinImport:off -- Builds skill folders, archives and an agent home in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as yauzl from "yauzl";

import * as ServerConfig from "../../config.ts";
import * as PersonalSkills from "./PersonalSkills.ts";
import { webSkillSource } from "./PersonalSkillSources.ts";
import * as ScientSkillManagement from "./ScientSkillManagement.ts";
import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";
import * as ScientSkillSession from "./ScientSkillSession.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-personal-skills-"));
  roots.push(root);
  return root;
};

const document = (name: string, description: string, body = "Follow these steps.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const writeFiles = async (root: string, files: Record<string, string>) => {
  for (const [path, contents] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), contents);
  }
};

const unzipNames = (bytes: Buffer) =>
  new Promise<string[]>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const names: string[] = [];
      zip.on("entry", (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(names.sort()));
      zip.readEntry();
    });
  });

/** No network in tests: every request fails. */
const offline = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 }))),
  ),
);

const harness = (baseDir: string, home: string) => {
  const config = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const shared = Layer.merge(ScientSkillRegistry.layer, ScientSkillPolicy.layer).pipe(
    Layer.provideMerge(config),
  );
  return ScientSkillManagement.layer.pipe(
    Layer.provideMerge(ScientSkillSession.layer),
    Layer.provideMerge(PersonalSkills.layer),
    Layer.provideMerge(shared),
    Layer.provide(offline),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
    Layer.provide(Layer.succeed(HostProcess.Environment, {})),
  );
};

/**
 * Runs a test against services whose state folder and home folder are both in a new scratch
 * folder. Tests write only under `home` from here, never the real home folder.
 */
const inScratch = <A, E>(
  body: (paths: { readonly home: string }) => Effect.Effect<A, E, ServerConfig.ServerConfig>,
) =>
  Effect.flatMap(Effect.promise(scratch), (base) => {
    const home = NodePath.join(base, "home");
    return body({ home }).pipe(Effect.provide(harness(NodePath.join(base, "state"), home)));
  });

describe("PersonalSkills", () => {
  it.live("adds skills from a folder, turns them on, keeps edits undoable and exports them", () =>
    inScratch(({ home }) =>
      Effect.gen(function* () {
        const source = NodePath.join(home, "from-classmate");
        yield* Effect.promise(() =>
          writeFiles(source, {
            "lab-notes/SKILL.md": document("lab-notes", "Keep lab notes the way our lab does."),
            "lab-notes/references/template.md": "# Template",
            "lab-notes/.DS_Store": "clutter",
            "pcr/SKILL.md": "Some notes about PCR, no header yet.",
          }),
        );
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const personal = management.personal;

        const inspection = yield* personal.inspect({ type: "path", path: source });
        expect(inspection.kind).toBe("skills");
        if (inspection.kind !== "skills") return;
        const byName = new Map(
          inspection.candidates.map((candidate) => [candidate.name, candidate]),
        );
        expect(byName.get("lab-notes")).toMatchObject({ status: "ready", exists: false });
        expect(byName.get("pcr")).toMatchObject({
          status: "needs-agent",
          reason: "It has no skill header with a name and a description.",
          material: { path: NodePath.join(source, "pcr") },
        });
        const ready = byName.get("lab-notes")!;

        // Material that needs an agent cannot be added as is.
        const refused = yield* personal
          .add({ stagingId: inspection.stagingId, keys: [byName.get("pcr")!.key] })
          .pipe(Effect.flip);
        expect(refused.message).toContain("needs an agent");

        expect(yield* personal.add({ stagingId: inspection.stagingId, keys: [ready.key] })).toEqual(
          ["lab-notes"],
        );
        const listed = (yield* management.list()).skills.find(
          (skill) => skill.name === "lab-notes",
        );
        expect(listed).toMatchObject({
          origin: "personal",
          scope: "user",
          active: true,
          personal: { source: "from-classmate", changedBy: "you", canUndo: true },
        });
        const folder = listed!.personal!.folder;
        expect((yield* Effect.promise(() => NodeFSP.readdir(folder))).sort()).toEqual([
          "SKILL.md",
          "references",
        ]);

        // The user turns it off; an agent's edit keeps that choice and can be undone.
        yield* management.setUserActivation({
          releaseKey: listed!.releaseKey,
          active: false,
          invocationPolicy: "automatic",
        });
        const saved = yield* personal.save({
          name: "lab-notes",
          files: { "SKILL.md": document("lab-notes", "Keep lab notes, now with dates.") },
        });
        expect(saved).toEqual({ created: false, active: false });
        const edited = (yield* management.list()).skills.find(
          (skill) => skill.name === "lab-notes",
        )!;
        expect(edited).toMatchObject({
          description: "Keep lab notes, now with dates.",
          active: false,
          personal: { changedBy: "agent", canUndo: true },
        });
        expect(edited.releaseKey).not.toBe(listed!.releaseKey);

        yield* personal.undo("lab-notes");
        const restored = (yield* management.list()).skills.find(
          (skill) => skill.name === "lab-notes",
        )!;
        expect(restored.description).toBe("Keep lab notes the way our lab does.");

        // Agents read every file, and Export packs the folder under its name.
        expect((yield* personal.read("lab-notes")).map((file) => file.path).sort()).toEqual([
          "SKILL.md",
          "references/template.md",
        ]);
        const exported = yield* personal.exportZip("lab-notes");
        expect(exported.fileName).toBe("lab-notes.zip");
        expect(
          yield* Effect.promise(() => unzipNames(Buffer.from(exported.base64, "base64"))),
        ).toEqual(["lab-notes/SKILL.md", "lab-notes/references/template.md"]);

        // Remove can be undone too.
        yield* personal.remove("lab-notes");
        expect((yield* management.list()).skills.some((skill) => skill.name === "lab-notes")).toBe(
          false,
        );
        yield* personal.undo("lab-notes");
        expect((yield* management.list()).skills.some((skill) => skill.name === "lab-notes")).toBe(
          true,
        );
      }),
    ),
  );

  it.live("an agent's new skill is checked, on at once, and Undo removes it", () =>
    inScratch(() =>
      Effect.gen(function* () {
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const personal = management.personal;
        const mismatch = yield* personal
          .save({ name: "plots", files: { "SKILL.md": document("charts", "Make charts.") } })
          .pipe(Effect.flip);
        expect(mismatch.message).toContain("set its name to 'plots'");
        const builtIn = yield* personal
          .save({
            name: "scient-skill-authoring",
            files: { "SKILL.md": document("scient-skill-authoring", "Mine.") },
          })
          .pipe(Effect.flip);
        expect(builtIn.message).toContain("already named");
        const escape = yield* personal
          .save({
            name: "plots",
            files: { "SKILL.md": document("plots", "Make plots."), "../x.md": "outside" },
          })
          .pipe(Effect.flip);
        expect(escape.message).toContain("invalid path");

        expect(
          yield* personal.save({
            name: "plots",
            files: { "SKILL.md": document("plots", "Make plots.") },
          }),
        ).toEqual({ created: true, active: true });
        // The next turn's plan includes it.
        const planner = yield* ScientSkillSession.ScientSkillSessionPlanner;
        const plan = yield* planner.resolve({
          provider: "codex" as never,
          mcpSessionAvailable: true,
        });
        expect(plan.skills.map((skill) => skill.name)).toContain("plots");

        yield* personal.undo("plots");
        expect((yield* management.list()).skills.some((skill) => skill.name === "plots")).toBe(
          false,
        );
      }),
    ),
  );

  it.live("reads pasted text, rough notes, broken folders and other agents' skills", () =>
    inScratch(({ home }) =>
      Effect.gen(function* () {
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const personal = management.personal;
        const config = yield* ServerConfig.ServerConfig;

        const pasted = yield* personal.inspect({
          type: "text",
          text: "---\ndescription: Summarize papers.\n---\nRead the abstract first.",
          name: "Paper Summaries",
        });
        expect(pasted).toMatchObject({
          kind: "skills",
          sourceLabel: "Pasted text",
          candidates: [{ status: "ready", name: "paper-summaries" }],
        });

        const rough = yield* personal.inspect({ type: "text", text: "Use n=3 replicates." });
        expect(rough).toMatchObject({
          kind: "skills",
          candidates: [{ status: "needs-agent", material: { text: "Use n=3 replicates." } }],
        });

        // A Scient plugin, even one with skills inside, is left to the plugin installer.
        const plugin = NodePath.join(home, "plugin");
        yield* Effect.promise(() =>
          writeFiles(plugin, {
            "scient.plugin.json": "{}",
            "skills/lab/SKILL.md": document("lab", "Lab guidance."),
          }),
        );
        expect(yield* personal.inspect({ type: "path", path: plugin })).toEqual({ kind: "none" });

        // A folder that is a connector is left to the connector path.
        const connector = NodePath.join(home, "connector");
        yield* Effect.promise(() =>
          writeFiles(connector, { "manifest.json": "{}", "README.md": "x" }),
        );
        expect(yield* personal.inspect({ type: "path", path: connector })).toEqual({
          kind: "none",
        });

        // A folder edited by hand into a broken skill is reported, not hidden.
        yield* Effect.promise(() =>
          writeFiles(NodePath.join(config.stateDir, "skills", "broken"), { "SKILL.md": "oops" }),
        );
        const inventory = yield* management.list();
        expect(inventory.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "personal-skill-invalid",
            path: NodePath.join(config.stateDir, "skills", "broken"),
          }),
        );
        yield* personal.remove("broken");
        expect((yield* management.list()).diagnostics).toEqual([]);

        yield* Effect.promise(() =>
          writeFiles(home, {
            ".claude/skills/review/SKILL.md": document("review", "Review drafts."),
            ".codex/skills/.system/SKILL.md": document("system", "Codex's own."),
            ".agents/skills/notes/SKILL.md": "rough",
          }),
        );
        expect(
          (yield* personal.importables).map((skill) => [skill.appLabel, skill.name, skill.added]),
        ).toEqual([
          ["Claude Code", "review", false],
          ["Other agents", "notes", false],
        ]);
      }),
    ),
  );
  it.live("refuses a new skill past the limit instead of pushing another out", () =>
    inScratch(() =>
      Effect.gen(function* () {
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const config = yield* ServerConfig.ServerConfig;
        const skills = NodePath.join(config.stateDir, "skills");
        // Every folder takes a place, valid or not, so empty folders fill the limit quickly.
        // They appear after Scient last read the folder: the save still counts them.
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 200 }, (_, index) =>
              NodeFSP.mkdir(NodePath.join(skills, `skill-${String(index).padStart(3, "0")}`), {
                recursive: true,
              }),
            ),
          ),
        );
        const refused = yield* management.personal
          .save({ name: "aaa-first", files: { "SKILL.md": document("aaa-first", "New.") } })
          .pipe(Effect.flip);
        expect(refused.message).toContain("200 skills");
        // Replacing one of them is still allowed.
        expect(
          yield* management.personal.save({
            name: "skill-000",
            files: { "SKILL.md": document("skill-000", "Edited.") },
          }),
        ).toMatchObject({ created: false });
      }),
    ),
  );
});

describe("webSkillSource", () => {
  it("tells skill sources from other web addresses", () => {
    expect(webSkillSource("https://github.com/acme/skills")).toEqual({
      download: "https://github.com/acme/skills/archive/HEAD.zip",
      as: "archive",
      fileName: "skills.zip",
    });
    expect(webSkillSource("https://github.com/acme/skills/tree/main/lab/notes")).toEqual({
      download: "https://github.com/acme/skills/archive/main.zip",
      as: "archive",
      inside: "lab/notes",
      fileName: "skills.zip",
    });
    expect(webSkillSource("https://github.com/acme/skills/blob/main/lab/notes/SKILL.md")).toEqual({
      download: "https://github.com/acme/skills/archive/main.zip",
      as: "archive",
      inside: "lab/notes",
      fileName: "skills.zip",
    });
    expect(webSkillSource("https://github.com/acme/skills/blob/main/notes.md")).toEqual({
      download: "https://raw.githubusercontent.com/acme/skills/main/notes.md",
      as: "text",
      fileName: "notes.md",
    });
    expect(webSkillSource("https://example.com/pack.skill")).toMatchObject({ as: "archive" });
    expect(webSkillSource("https://example.com/SKILL.md")).toMatchObject({ as: "text" });
    expect(webSkillSource("https://mcp.example.com/mcp")).toBeUndefined();
    expect(webSkillSource("file:///etc/passwd")).toBeUndefined();
  });
});
