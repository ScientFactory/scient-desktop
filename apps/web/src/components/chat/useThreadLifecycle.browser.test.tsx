import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { environmentThreadDetails } from "../../state/threads";
import { useActiveRunStop } from "./useThreadLifecycle";

const ref = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
type Shell = Parameters<typeof useActiveRunStop>[1];

function Probe(props: { readonly shell: Shell }) {
  useActiveRunStop(ref, props.shell);
  return null;
}

it("reads a thread's Stop state only once the shell lists it", async () => {
  using runStop = vi.spyOn(environmentThreadDetails, "runStopAtom");
  await using screen = await render(<Probe shell={null} />);
  expect(runStop).not.toHaveBeenCalled();

  await screen.rerender(<Probe shell={{} as Shell} />);
  expect(runStop).toHaveBeenCalledWith(ref);
});
