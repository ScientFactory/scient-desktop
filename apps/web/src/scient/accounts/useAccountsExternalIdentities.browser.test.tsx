import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import { useAccountsExternalIdentities } from "./useAccountsExternalIdentities";

const query = vi.hoisted(() => ({
  pending: new Map<string, boolean>(),
  refreshes: new Map<string, number>(),
  refresh: new Map<string, () => void>(),
}));

vi.mock("./accountsState", () => ({
  accountsState: {
    externalIdentities: ({ environmentId }: { environmentId: string }) => ({ environmentId }),
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { environmentId: string } | null) => {
    if (atom === null) return { data: null, isPending: false, refresh: () => {} };
    const { environmentId } = atom;
    if (!query.refresh.has(environmentId)) {
      query.refresh.set(environmentId, () => {
        query.refreshes.set(environmentId, (query.refreshes.get(environmentId) ?? 0) + 1);
      });
    }
    return {
      data: { identities: [], complete: false },
      isPending: query.pending.get(environmentId) ?? false,
      refresh: query.refresh.get(environmentId),
    };
  },
}));

function Probe({ environmentId }: { readonly environmentId: EnvironmentId }) {
  useAccountsExternalIdentities(environmentId);
  return null;
}

const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");

it("gives each environment its own bounded retry budget for incomplete results", async ({
  signal,
}) => {
  query.pending.clear();
  query.refreshes.clear();
  query.refresh.clear();
  using _timers = fakeTimers();
  await using screen = await render(<Probe environmentId={first} />, { router: false });
  // Each refresh's round trip: pending, then incomplete again.
  const answer = async (environmentId: EnvironmentId) => {
    query.pending.set(environmentId, true);
    await screen.rerender(<Probe environmentId={environmentId} />);
    query.pending.set(environmentId, false);
    await screen.rerender(<Probe environmentId={environmentId} />);
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await advanceTestClock(signal, 5_000);
    await answer(first);
  }
  expect(query.refreshes.get(first)).toBe(3);

  await screen.rerender(<Probe environmentId={second} />);
  await advanceTestClock(signal, 5_000);
  expect(query.refreshes.get(second)).toBe(1);
});
