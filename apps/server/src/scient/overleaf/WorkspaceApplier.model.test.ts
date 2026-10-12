// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { fixture } from "./WorkspaceApplier.testkit.ts";
import { modelCases } from "./WorkspaceApplier.model-cases.testkit.ts";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
const revisions = (files: Readonly<Record<string, string>>) =>
  new Map(Object.entries(files).map(([name, text]) => [name, bytesRevision(Buffer.from(text))]));
const sorted = (tree: ReadonlyMap<string, string>) =>
  [...tree].sort(([a], [b]) => a.localeCompare(b));
for (const model of modelCases) {
  (process.platform === "darwin" ? it.live : it.live.skip)(
    `matches independent checker base: ${model.action} crash=${model.crash}`,
    () => {
      let stop = model.crash,
        folder = "";
      return fixture(
        async (h) => {
          folder = h.cwd;
          for (const [name, contents] of Object.entries(model.captured))
            await NodeFSP.writeFile(NodePath.join(h.cwd, name), contents);
          const plan = {
            base: revisions(model.base),
            remote: revisions(model.remote),
            captured: revisions(model.captured),
            target: new Map(
              Object.entries(model.target).map(([name, text]) => [
                name,
                { bytes: Buffer.from(text) },
              ]),
            ),
            renames: [{ from: "old.tex", to: "new.tex" }],
            conflicts: [],
            markerPaths: [],
          };
          let actual;
          if (model.crash) {
            await expect(h.apply("independent-model", plan)).rejects.toBeTruthy();
            if (model.action === "source-edit")
              await NodeFSP.writeFile(NodePath.join(h.cwd, "old.tex"), model.later);
            await h.restart();
            actual = await h.apply("independent-model");
          } else actual = await h.apply("independent-model", plan);
          expect(sorted(actual.base)).toEqual(sorted(revisions(model.expectedBase)));
          if (model.action === "source-edit") {
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, "old.tex"), "utf8")).toBe(
              model.later,
            );
            expect(
              actual.interrupted.some(
                (group) => group.includes("old.tex") && group.includes("new.tex"),
              ),
            ).toBe(true);
          } else expect(actual).toMatchObject({ outcome: "complete", matchesTarget: true });
        },
        {
          at: async (point, name) => {
            if (point === "after-step" && name === "new.tex") {
              if (stop) {
                stop = false;
                throw new Error("crash");
              }
              if (!model.crash && model.action === "source-edit")
                await NodeFSP.writeFile(NodePath.join(folder, "old.tex"), model.later);
            }
          },
        },
      );
    },
  );
}
