import { render } from "../../../test/render";

import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRefreshAfterAgentTurns } from "./useRefreshAfterAgentTurns";

type Shell = {
  readonly environmentId: string;
  readonly id: string;
  readonly runtime: { readonly status: string } | null;
};
const shells = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("~/state/threads", () => {
  shells.atom = Atom.make<ReadonlyArray<Shell>>([]);
  return { environmentThreadShells: { quietThreadShellsAtom: shells.atom } };
});
const atom = () => shells.atom as Atom.Writable<ReadonlyArray<Shell>>;

function Harness(props: { readonly refresh: () => void }) {
  useRefreshAfterAgentTurns("environment-1" as EnvironmentId, props.refresh);
  return null;
}

it("reads the Library again when an agent turn in its environment ends", async () => {
  const refresh = vi.fn();
  const shell = (id: string, status: string, environmentId = "environment-1"): Shell => ({
    environmentId,
    id,
    runtime: { status },
  });
  appAtomRegistry.set(atom(), [shell("a", "running"), shell("b", "running", "environment-2")]);
  await using _screen = await render(<Harness refresh={refresh} />, { router: false });

  // Another environment's turn ends: not this Library's.
  appAtomRegistry.set(atom(), [shell("a", "running"), shell("b", "idle", "environment-2")]);
  expect(refresh).not.toHaveBeenCalled();
  appAtomRegistry.set(atom(), [shell("a", "idle"), shell("b", "idle", "environment-2")]);
  expect(refresh).toHaveBeenCalledTimes(1);
  // A turn that starts reads nothing.
  appAtomRegistry.set(atom(), [shell("a", "running"), shell("b", "idle", "environment-2")]);
  expect(refresh).toHaveBeenCalledTimes(1);
});
