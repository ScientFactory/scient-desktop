import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import {
  discoverDroidSkills,
  droidSkillsToServerProviderSkills,
  type DroidSkillInventoryClientFactory,
} from "./DroidSkills.ts";

it("maps Droid's native locations and invocation state without recreating precedence", () => {
  NodeAssert.deepEqual(
    droidSkillsToServerProviderSkills([
      {
        name: "project-review",
        description: "Review the project.",
        location: "project",
        filePath: "/work/.factory/skills/project-review/SKILL.md",
        enabled: true,
        userInvocable: true,
      },
      {
        name: "personal-review",
        location: "personal",
        filePath: "/home/user/.factory/skills/personal-review/SKILL.md",
        enabled: false,
        userInvocable: false,
      },
      {
        name: "built-in",
        location: "builtin",
        filePath: "builtin:built-in",
      },
      {
        name: "automation",
        location: "automation",
        filePath: "automation:nightly",
      },
    ]),
    [
      {
        name: "automation",
        path: "automation:nightly",
        scope: "automation",
        enabled: true,
      },
      { name: "built-in", path: "builtin:built-in", scope: "builtin", enabled: true },
      {
        name: "personal-review",
        path: "/home/user/.factory/skills/personal-review/SKILL.md",
        scope: "personal",
        enabled: false,
        userInvocable: false,
      },
      {
        name: "project-review",
        path: "/work/.factory/skills/project-review/SKILL.md",
        scope: "project",
        enabled: true,
        userInvocable: true,
        description: "Review the project.",
        shortDescription: "Review the project.",
      },
    ],
  );
});

it("skips incomplete Droid skill rows and sorts stable ties by path", () => {
  NodeAssert.deepEqual(
    droidSkillsToServerProviderSkills([
      { name: "same", location: "personal", filePath: "/z/SKILL.md" },
      { name: "", location: "personal", filePath: "/missing-name/SKILL.md" },
      { name: "same", location: "personal", filePath: "/a/SKILL.md" },
      { name: "missing-path", location: "personal", filePath: "" },
    ]).map(({ name, path }) => ({ name, path })),
    [
      { name: "same", path: "/a/SKILL.md" },
      { name: "same", path: "/z/SKILL.md" },
    ],
  );
});

it.effect("decodes native inventory and always closes the client", () =>
  Effect.gen(function* () {
    let closed = 0;
    const makeClient: DroidSkillInventoryClientFactory = async () => ({
      close: async () => {
        closed += 1;
      },
      listSkills: async () => ({
        projectAvailable: true,
        skills: [
          {
            name: "review",
            description: "Review changes.",
            location: "personal",
            filePath: "/skills/review/SKILL.md",
            enabled: true,
          },
        ],
      }),
    });

    const skills = yield* discoverDroidSkills(
      { binaryPath: "droid", cwd: "/work", environment: {} },
      makeClient,
    );
    NodeAssert.deepEqual(
      skills.map(({ name, scope }) => ({ name, scope })),
      [{ name: "review", scope: "personal" }],
    );
    NodeAssert.equal(closed, 1);
  }),
);

it.effect("rejects invalid native inventory and still closes the client", () =>
  Effect.gen(function* () {
    let closed = 0;
    const makeClient: DroidSkillInventoryClientFactory = async () => ({
      close: async () => {
        closed += 1;
      },
      listSkills: async () => ({
        skills: [{ name: "future", location: "unknown", filePath: "/future/SKILL.md" }],
      }),
    });

    const exit = yield* Effect.exit(
      discoverDroidSkills({ binaryPath: "droid", cwd: "/work", environment: {} }, makeClient),
    );
    NodeAssert.equal(Exit.isFailure(exit), true);
    NodeAssert.equal(closed, 1);
  }),
);

it.effect("reports startup failure without acquiring a client", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      discoverDroidSkills({ binaryPath: "missing", cwd: "/work", environment: {} }, async () => {
        throw new Error("spawn failed");
      }),
    );
    NodeAssert.equal(Exit.isFailure(exit), true);
  }),
);

it.effect("closes an acquired client when discovery is interrupted", () =>
  Effect.gen(function* () {
    let closed = 0;
    let markListStarted: (() => void) | undefined;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const makeClient: DroidSkillInventoryClientFactory = async () => ({
      close: async () => {
        closed += 1;
      },
      listSkills: () => {
        markListStarted?.();
        return new Promise(() => undefined);
      },
    });

    const fiber = yield* discoverDroidSkills(
      { binaryPath: "droid", cwd: "/work", environment: {} },
      makeClient,
    ).pipe(Effect.forkChild);
    yield* Effect.promise(() => listStarted);
    yield* Fiber.interrupt(fiber);
    NodeAssert.equal(closed, 1);
  }),
);
