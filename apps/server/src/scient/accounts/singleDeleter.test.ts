// @effect-diagnostics nodeBuiltinImport:off -- Reads this directory's own sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

it("deletes stored values and escrows in one place only: the sweep", () => {
  // The one deleter (`sweepUnreferenced`): every other path journals what it lets go. Each call
  // is named by the service member it sits in, so a deletion moved elsewhere is caught too.
  const dir = NodePath.dirname(new URL(import.meta.url).pathname);
  const sources = NodeFS.readdirSync(dir).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".testkit.ts"),
  );
  const calls = sources.flatMap((file) => {
    const text = NodeFS.readFileSync(NodePath.join(dir, file), "utf8");
    return [...text.matchAll(/persistence\s*\.\s*(remove|removeEscrow)\(/g)].map((call) => {
      const before = text.slice(0, call.index);
      const members = [...before.matchAll(/\n {4}const (\w+)\b/g)];
      return `${file}:${members.at(-1)?.[1] ?? "?"}:${call[1]}`;
    });
  });
  expect(calls).toEqual([
    "AccountsServiceLive.ts:sweepUnreferenced:remove",
    "AccountsServiceLive.ts:sweepUnreferenced:removeEscrow",
  ]);
});
