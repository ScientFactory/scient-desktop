// @effect-diagnostics nodeBuiltinImport:off -- Test compares embedded bytes with review files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID,
  BUILT_IN_SKILL_RELEASES,
} from "./BuiltInSkillReleases.ts";
import { BUILT_IN_SKILL_SOURCES } from "./BuiltInSkillSources.ts";

describe("Scient built-in skill releases", () => {
  it("embeds the three reviewed releases with explicit product-owned defaults", () => {
    expect(BUILT_IN_SKILL_RELEASES).toMatchObject([
      {
        id: "scient.workspace-readiness-review",
        version: "0.1.0",
        category: "Workspace readiness",
        categoryDescription:
          "Review and improve a workspace so people and agents can understand it and work safely.",
        displayOrder: 10,
        supportedScopes: ["project", "user"],
        defaultInvocationPolicy: "automatic",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.improve-workspace-readiness",
        version: "0.1.0",
        category: "Workspace readiness",
        categoryDescription:
          "Review and improve a workspace so people and agents can understand it and work safely.",
        displayOrder: 20,
        supportedScopes: ["project", "user"],
        defaultInvocationPolicy: "explicit",
        origin: "scient",
        resources: [],
      },
      {
        id: "scient.skill-authoring",
        version: "0.1.0",
        category: "Skill creation",
        categoryDescription: "Create and improve reusable guidance for Scient agents.",
        displayOrder: 30,
        supportedScopes: ["user"],
        defaultInvocationPolicy: "automatic",
        origin: "scient",
        resources: [],
      },
    ]);
    expect(BUILT_IN_SKILL_RELEASES.every((release) => release.instructions.length > 0)).toBe(true);
    expect(Object.fromEntries(BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID)).toEqual({
      "scient.workspace-readiness-review": true,
      "scient.improve-workspace-readiness": true,
      "scient.skill-authoring": true,
    });
  });

  it("keeps bundle-safe bytes identical to the human-reviewable release files", async () => {
    for (const source of BUILT_IN_SKILL_SOURCES) {
      const root = NodePath.join(import.meta.dirname, "built-ins", source.directoryName);
      for (const [relativePath, contents] of Object.entries(source.files)) {
        await expect(NodeFSP.readFile(NodePath.join(root, relativePath), "utf8")).resolves.toBe(
          contents,
        );
      }
    }
  });
});
