# Product usage data

Scient collects data about how the app is used, so we can understand what works
and make it better. It never includes your prompts, responses, files, research or
credentials.

Usage data goes to Scient's own service, not to T3. Development builds do not send
it.

## What is collected

- Which features and Settings pages you use, and whether they work.
- Which providers and models you use, how long turns take, and how they end.
- Token counts reported by your providers. Missing counts stay unknown.
- Whether a turn was started by you, an agent or a schedule.
- Which agent tools run, how long they take and whether they succeed.
- How many threads and projects you have. Only the numbers, never their names.
- Your app version, operating system, device type and how you connected.
- A random identifier for this installation.
- A scrambled form of your account ID if you sign in to Codex with ChatGPT or to
  Claude. It lets us recognize one person across computers. We can't turn it back
  into your account ID, and we don't receive your name or email.

## What is never collected

Prompts, responses, file contents, file names and paths, URLs, research results,
credentials, raw provider events and private custom model names. The Usage page's
wider local history stays on your computer.

## Turning it off

There is no setting for this in the app. To stop sending usage data, set
`SCIENT_ANALYTICS_ENABLED=false` in the environment before starting Scient.
