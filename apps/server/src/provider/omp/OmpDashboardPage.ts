/**
 * `/stats` and `/trace` start the agent's local dashboard and report its address. In the terminal
 * the agent opens that page itself; in Scient the page opens in the conversation's browser.
 */

const DASHBOARD_COMMAND = /^\/(?:stats|trace)(?:\s|$)/;
// The dashboard binds to this computer, so only a local address is the page to open.
const LOCAL_PAGE =
  /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:[/?#][^\s<>"'`)\]]*)?/;

/** Whether the message runs a command whose answer is a dashboard page. */
export function ompOpensDashboard(text: string): boolean {
  return DASHBOARD_COMMAND.test(text.trimStart());
}

/** The local dashboard address in a command's output, if it reports one. */
export function ompDashboardUrl(text: string): string | undefined {
  return LOCAL_PAGE.exec(text)?.[0];
}

/**
 * `/trace` names the conversation by its real file, but the dashboard accepts only files under
 * its own sessions folder, which reaches Scient's folder through a link. Name it through the link.
 */
export function ompDashboardThroughLink(
  text: string,
  sessions: { readonly root: string; readonly link: string } | undefined,
): string {
  if (!sessions) return text;
  return text.replaceAll(
    `s=${encodeURIComponent(sessions.root)}`,
    `s=${encodeURIComponent(sessions.link)}`,
  );
}
