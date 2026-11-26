import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { PublishRepositoryDialog } from "./GitActionsControl";

const queryState = vi.hoisted(() => ({
  seenAtoms: [] as Array<unknown>,
  isPending: true,
  data: null as unknown,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    queryState.seenAtoms.push(atom);
    return {
      data: atom === null ? null : queryState.data,
      isPending: atom !== null && queryState.isPending,
      isSuccess: atom !== null && queryState.data !== null,
      error: null,
      failure: null,
      dataUpdatedAt: 0,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("~/state/sourceControlActions", () => ({
  useGitStackedAction: vi.fn(),
  useSourceControlActionRunning: vi.fn(),
  useVcsInitAction: vi.fn(),
  useVcsPullAction: vi.fn(),
  useSourceControlPublishRepositoryAction: () => ({
    isAllowed: true,
    isPending: false,
    run: vi.fn(),
  }),
}));

const environmentId = EnvironmentId.make("local");

it("does not query discovery while closed and shows Checking… while cold discovery is pending", async () => {
  queryState.seenAtoms = [];
  queryState.isPending = true;
  queryState.data = null;

  await using closed = await render(
    <PublishRepositoryDialog
      open={false}
      onOpenChange={() => {}}
      environmentId={environmentId}
      threadRef={null}
      gitCwd="/repo"
      offeredProviders={undefined}
    />,
  );
  expect(queryState.seenAtoms.every((atom) => atom === null)).toBe(true);
  await closed[Symbol.asyncDispose]();

  queryState.seenAtoms = [];
  await using _open = await render(
    <PublishRepositoryDialog
      open
      onOpenChange={() => {}}
      environmentId={environmentId}
      threadRef={null}
      gitCwd="/repo"
      offeredProviders={undefined}
    />,
  );
  expect(queryState.seenAtoms.some((atom) => atom !== null)).toBe(true);
  await expect.element(page.getByText("Checking…").first()).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Setup Required" }))
    .not.toBeInTheDocument();
});
