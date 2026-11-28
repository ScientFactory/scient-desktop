import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { useUniversityRestart } from "./UniversitySignInCover";

vi.mock("./useAccounts", () => ({
  useAccounts: () => ({
    data: {
      accounts: [
        {
          accountId: "acc_huji_restart",
          name: "Hebrew University",
          details: {
            kind: "website",
            sites: ["huji.ac.il"],
            institution: {
              name: "Hebrew University",
              entityId: "https://idp.huji.ac.il/openathens",
              domain: "huji.ac.il",
            },
          },
        },
      ],
      attempts: [
        {
          attemptId: "a",
          threadId: "thread-restart",
          tabId: "tab-signing-in",
          accountId: "acc_huji_restart",
          state: "person",
        },
      ],
    },
  }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("synthetic"),
  threadId: ThreadId.make("thread-restart"),
} as ScopedThreadRef;

function Restart({ tabId }: { tabId: string }) {
  return <output>{useUniversityRestart(threadRef, tabId, "https://idp.huji.ac.il/")}</output>;
}

it("starts the Chrome window at the university's entry route, not its identity provider", async () => {
  await using _screen = await render(
    <>
      <Restart tabId="tab-signing-in" />
      <Restart tabId="tab-elsewhere" />
    </>,
  );
  await expect
    .element(page.getByText("https://my.openathens.net/auth?", { exact: false }))
    .toBeVisible();
  // Another tab's refusal restarts where Google's refusal said.
  await expect.element(page.getByText("https://idp.huji.ac.il/", { exact: true })).toBeVisible();
});
