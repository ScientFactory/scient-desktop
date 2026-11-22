import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useCloudList } from "./useCloudList";

function Links({ userId, load }: { userId: string; load: () => Promise<ReadonlyArray<string>> }) {
  const { items } = useCloudList(load, `shares:${userId}`);
  return <p>{items === null ? "loading" : items.join(", ")}</p>;
}

describe("useCloudList", () => {
  it("never shows one account's list after another account signs in", async () => {
    await using screen = await render(
      <Links userId="user-a" load={async () => ["A's private link"]} />,
      { router: false },
    );
    await expect.element(screen.getByText("A's private link")).toBeVisible();

    // B's read is still in flight: A's rows must already be gone.
    await screen.rerender(<Links userId="user-b" load={() => new Promise(() => {})} />);
    await expect.element(screen.getByText("loading")).toBeVisible();
    expect(screen.container.textContent).not.toContain("A's private link");
  });
});
