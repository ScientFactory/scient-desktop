import { render } from "../../test/render";
import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ mint: vi.fn() }));

vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
  readEnvironmentScope: () => true,
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: vi.fn(() => ({})) },
}));
// The real runner returns a fresh function on every render; the refresh
// callback built on it must not churn identity with it.
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => (target: unknown) => state.mint(target),
}));

import { useAssetUrlRefresh } from "./assetUrls";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");

function Fixture(props: {
  resource: AssetResource;
  record: (refresh: () => Promise<string | null>) => void;
}) {
  const refresh = useAssetUrlRefresh(environmentId, props.resource);
  props.record(refresh);
  return null;
}

// SCIENT-FORK:START — a re-render must not re-mint the URL (Office previews remount on a new URL).
it("keeps the refresh callback stable across rerenders and reads the latest resource", async () => {
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/doc.pptx", expiresAt: 1 }));
  const seen: Array<() => Promise<string | null>> = [];
  const record = (refresh: () => Promise<string | null>) => {
    seen.push(refresh);
  };
  const resource = (path: string): AssetResource =>
    ({ _tag: "media-file", threadId, path }) as AssetResource;
  await using screen = await render(
    <Fixture resource={resource("/repo/a.pptx")} record={record} />,
  );
  await screen.rerender(<Fixture resource={resource("/repo/a.pptx")} record={record} />);
  await screen.rerender(<Fixture resource={resource("/repo/b.pptx")} record={record} />);
  expect(seen.length).toBeGreaterThanOrEqual(3);
  expect(new Set(seen).size).toBe(1);
  await expect(seen.at(-1)!()).resolves.toBe("https://host.test/api/assets/doc.pptx");
  expect(state.mint).toHaveBeenCalledWith({
    environmentId,
    input: { resource: resource("/repo/b.pptx") },
  });
});
// SCIENT-FORK:END
