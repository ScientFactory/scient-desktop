/**
 * Scient tools whose call stays open until the person answers a card (a key, a client
 * secret, a sign-in code). Codex must call them directly, never from a Code Mode cell: a
 * cell yields after about 30 s, the model moves on and ends its turn, and the run's end
 * closes the card while the person is still typing.
 */
export const SCIENT_PERSON_WAIT_TOOLS = [
  "request_secret",
  "scient_account_add",
  "scient_account_sign_in",
  "scient_connector_setup",
  "scient_connector_add",
] as const;

/**
 * A caller that sends nothing while it waits is cut at about 300 s by the HTTP client of many
 * agents (Node's fetch, Bun's fetch); T3 caps its task waits at 4 minutes for the same reason. A
 * card for an agent not listed below closes before that.
 */
const DEFAULT_PERSON_WAIT_MS = 4 * 60_000;

/**
 * How long a private card may wait for the person, by the calling agent's driver: less than that
 * agent keeps one silent tool call open, so the card closes first and the agent hears a clean
 * `timed_out` instead of losing the call. Replace with progress heartbeats once T3 sends them.
 */
const PERSON_WAIT_MS_BY_DRIVER: Readonly<Record<string, number>> = {
  // Antigravity ends a tool call after 180 s.
  antigravity: 150_000,
  // Scient's bridge for Scient Agent and Oh My Pi turns Bun's fetch deadline off and keeps a
  // call open for over an hour.
  scient: 10 * 60_000,
  omp: 10 * 60_000,
};

/** How long a card waits for the person when `driver` is calling. */
export const personWaitMs = (driver: string | undefined): number =>
  (driver === undefined ? undefined : PERSON_WAIT_MS_BY_DRIVER[driver]) ?? DEFAULT_PERSON_WAIT_MS;
