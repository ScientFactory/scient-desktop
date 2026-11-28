import { describe, expect, it } from "vite-plus/test";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const tapped = (deepLink: string) => ({
  notification: { request: { identifier: "push-1", content: { data: { deepLink } } } },
});

describe("a background sign-in's notification", () => {
  it("opens Accounts, while a chat's opens the chat", () => {
    // regression: it opened a chat that doesn't exist.
    expect(extractAgentNotificationDeepLink(tapped("/threads/env-1/scient-accounts-renewal"))).toBe(
      "/settings/environments/env-1/accounts",
    );
    expect(extractAgentNotificationDeepLink(tapped("/threads/env-1/thread-42"))).toBe(
      "/threads/env-1/thread-42",
    );
  });
});
