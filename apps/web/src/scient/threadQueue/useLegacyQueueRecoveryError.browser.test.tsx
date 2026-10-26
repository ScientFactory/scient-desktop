import { EnvironmentId, ScientThreadQueueOperationError, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ list: vi.fn<() => Promise<unknown>>() }));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePreparedConnection: (() => Option.some({})) as never,
}));
vi.mock(import("./client"), async (importOriginal) => ({
  ...(await importOriginal()),
  listThreadQueue: (() => state.list()) as never,
}));

import { render } from "../../../test/render";
import { useLegacyQueueRecoveryError } from "./useLegacyQueueRecoveryError";

function Probe() {
  const error = useLegacyQueueRecoveryError(
    EnvironmentId.make("environment"),
    ThreadId.make("thread"),
  );
  return <span>{error ?? "none"}</span>;
}

it("shows retained queue work that needs recovery, and ignores a failed request", async () => {
  state.list.mockRejectedValueOnce(
    new ScientThreadQueueOperationError({ message: "Saved queued work requires recovery." }),
  );
  await using recovery = await render(<Probe />);
  await expect.element(recovery.getByText("Saved queued work requires recovery.")).toBeVisible();

  state.list.mockRejectedValueOnce(new Error("The selected environment is not connected."));
  await using transient = await render(<Probe />);
  await vi.waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
  expect(transient.container.textContent).toBe("none");
});
