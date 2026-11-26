import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { announceSourcesMovedToTrash } from "./SourcesBulkBar";

const mocks = vi.hoisted(() => ({ restore: vi.fn(), toast: vi.fn(), close: vi.fn() }));
vi.mock("./client", () => ({ restoreScientSource: mocks.restore }));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: mocks.toast, close: mocks.close },
}));

it("says why removals failed, and Undo restores a few at a time and says which did not come back", async () => {
  mocks.toast.mockReset().mockReturnValue("toast");
  let inFlight = 0;
  let mostInFlight = 0;
  mocks.restore.mockReset().mockImplementation(async (_environment, { sourceId }) => {
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    if (sourceId === "s3") throw new Error("The Library is busy.");
    return { outcome: "restored" };
  });
  const onRestored = vi.fn(async () => {
    throw new Error("The list could not be read.");
  });
  const sourceIds = Array.from({ length: 9 }, (_, index) => `s${index}`);
  announceSourcesMovedToTrash({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    sourceIds,
    notRemoved: 0,
    failed: { count: 2, reason: "The Library is busy." },
    onRestored,
  });
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      title: "2 sources could not be moved to Trash",
      description: "The Library is busy.",
    }),
  );

  const moved = mocks.toast.mock.calls.find(([toast]) => toast.type === "success")![0];
  mocks.toast.mockClear();
  moved.actionProps.onClick();
  await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(9));
  await vi.waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "1 source was not restored",
        description: "The Library is busy. Open the Trash to restore it.",
      }),
    ),
  );
  expect(mostInFlight).toBeLessThanOrEqual(4);
  // The restores worked; a list that cannot be read afterwards is not reported as a failed restore.
  await vi.waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  expect(mocks.toast).toHaveBeenCalledTimes(1);
});
