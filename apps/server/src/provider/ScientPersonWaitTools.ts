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
