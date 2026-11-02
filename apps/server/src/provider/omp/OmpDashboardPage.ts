/**
 * `/stats` and `/trace` start the agent's local dashboard and report its address. In the terminal
 * the agent opens that page itself; in Scient the page opens in the conversation's browser.
 */

const DASHBOARD_COMMAND = /^\/(stats|trace)(?:\s|$)/;
const PROGRESS = /^\s*Syncing session files\.*\s*$/;
// The dashboard binds to this computer, so only a local address is the page to open.
const LOCAL_PAGE =
  /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:[/?#][^\s<>"'`)\]]*)?/;

export type OmpDashboardCommand = "stats" | "trace";

/** The command, when the message runs one whose answer is a dashboard page. */
export function ompDashboardCommand(text: string): OmpDashboardCommand | undefined {
  const command = DASHBOARD_COMMAND.exec(text.trimStart())?.[1];
  return command === "stats" || command === "trace" ? command : undefined;
}

/** The agent's line while it starts the dashboard; the page itself follows. */
export function ompDashboardProgress(text: string): boolean {
  return PROGRESS.test(text);
}

/** A named link in place of the agent's raw address, which can run to several lines. */
export function ompDashboardLink(command: OmpDashboardCommand, url: string): string {
  return `[${command === "stats" ? "Stats dashboard" : "Trace of this conversation"}](${url})`;
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
