import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const answers = vi.hoisted(() => [] as Array<{ readonly _tag: string }>);
vi.mock("./accountsState", () => ({
  accountsState: { mainWithdrawn: { run: async () => answers.shift() } },
}));

const { takeBackVia } = await import("./mainFill");

it("counts the take-back as persisted only when its command answers Success", async () => {
  const takeBack = takeBackVia(AtomRegistry.make(), EnvironmentId.make("environment-fixture"));
  answers.push({ _tag: "Failure" }, { _tag: "Success" });
  expect([await takeBack(["github.com"]), await takeBack(["github.com"])]).toEqual([false, true]);
});
