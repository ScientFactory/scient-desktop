import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { WindowEditors } from "../../scient/editorFlush/flushFolderEditors";
import { prepareDesktopUpdateSave } from "./prepareDesktopUpdateSave";

function fixture() {
  const targets = ["local", "disconnected"].map((id) => ({
    environmentId: EnvironmentId.make(id),
    cwd: "/synthetic",
    relativePath: `${id}.txt`,
  }));
  const dirty = new Set(targets);
  const saved: string[] = [];
  let afterSave: ((id: string) => void) | undefined;
  const editors: WindowEditors = {
    documents: {
      getSnapshot: () => [],
      getTargetSnapshot: () => null,
      has: () => false,
      open: async () => {
        throw new Error("No document editor in this fixture");
      },
    },
    latexInputs: { targets: () => [], commitWhere: () => [], inspectWhere: () => [] },
    compositions: { targets: () => [], composingWhere: () => [] },
    fileSessions: {
      sessionTargets: () => targets,
      unsavedWhere: (select) =>
        [...dirty].filter(select).map((target) => ({ target, problem: null })),
      flushWhere: async (select) =>
        targets.filter(select).map((target) => {
          dirty.delete(target);
          saved.push(target.environmentId);
          afterSave?.(target.environmentId);
          return { target, saved: true };
        }),
    },
  };
  return {
    editors,
    dirty,
    targets,
    saved,
    afterSave: (hook: (id: string) => void) => {
      afterSave = hook;
    },
  };
}

it("saves dirty editors even in disconnected environments and flushes staged composer persistence", async () => {
  const f = fixture();
  let composerPersisted = false;
  expect(
    await prepareDesktopUpdateSave(f.editors, () => {
      composerPersisted = true;
    }),
  ).toBe(true);
  expect(composerPersisted).toBe(true);
  expect(f.dirty.size).toBe(0);
  expect(f.saved).toContain("disconnected");
});

it("rechecks earlier environments if edited while another environment saves", async () => {
  const f = fixture();
  let edited = false;
  f.afterSave((id) => {
    if (id === "disconnected" && !edited) {
      edited = true;
      f.dirty.add(f.targets[0]!);
    }
  });
  expect(await prepareDesktopUpdateSave(f.editors, () => {})).toBe(true);
  expect(f.dirty.size).toBe(0);
  expect(f.saved.filter((id) => id === "local")).toHaveLength(2);
});

it("fails closed for ongoing edits, composition or composer persistence failure", async () => {
  const f = fixture();
  f.afterSave(() => {
    f.dirty.add(f.targets[0]!);
  });
  expect(await prepareDesktopUpdateSave(f.editors, () => {})).toBe(false);
  const composing = fixture();
  composing.editors.compositions.composingWhere = () => [composing.targets[0]!];
  expect(await prepareDesktopUpdateSave(composing.editors, () => {})).toBe(false);
  expect(
    await prepareDesktopUpdateSave(fixture().editors, () => {
      throw new Error("Storage full");
    }),
  ).toBe(false);
});
