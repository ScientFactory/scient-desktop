import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./openProfile", () => ({ accountsSnapshot: vi.fn() }));

import { browserProfileMenu } from "./threadProfileMenu";

const profiles = [
  { id: "default", name: "Main" },
  { id: "work", name: "Work" },
];
const checked = (menu: ReturnType<typeof browserProfileMenu>) =>
  menu.children?.filter((item) => item.checked).map((item) => item.label);

describe("browserProfileMenu", () => {
  it("offers the project's profile first, checked until the conversation has its own", () => {
    const menu = browserProfileMenu({
      profiles,
      defaultProfileId: "default",
      projectProfileId: "work",
      threadProfileId: undefined,
    });
    expect(menu.children?.map((item) => item.label)).toEqual(["Project's (Work)", "Main", "Work"]);
    expect(checked(menu)).toEqual(["Project's (Work)"]);
    expect(
      checked(
        browserProfileMenu({
          profiles,
          defaultProfileId: "default",
          projectProfileId: "work",
          threadProfileId: "default",
        }),
      ),
    ).toEqual(["Main"]);
  });

  it("names the new-tab default when the project has no profile, or one that is gone", () => {
    const menu = browserProfileMenu({
      profiles,
      defaultProfileId: "work",
      projectProfileId: "removed",
      threadProfileId: "removed",
    });
    expect(menu.children?.[0]).toMatchObject({ label: "Default (Work)", checked: true });
  });
});
