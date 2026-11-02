# Product usage data

Scient collects data about how the app is used, so we can understand what works
and make it better. It never includes your prompts, responses, files, research or
credentials.

Usage data goes to Scient's own service, not to T3. Development builds do not send
it.

## What is collected

- Which features and Settings pages you use, and whether they work. This
  includes Scient's own features, whether you use them or an agent does: Compute
  and the language you run, notebooks, LaTeX, Overleaf sync, Sources, papers,
  Accounts, extensions, skills, exports and the thread queue.
- Which providers and models you use, by name, how long turns take, and how they
  end.
- Token counts reported by your providers, with how many model requests a turn
  made, how long they took and the provider's cost estimate. Missing counts stay
  unknown.
- For each message you send, its length and counts of signs of frustration, such
  as all-caps sentences, swearing or "no, that's not what I asked". Only the
  counts are sent, never the message.
- Whether a turn was started by you, an agent or a schedule.
- Which agent tools run, how long they take and whether they succeed.
- How many threads and projects you have. Only the numbers, never their names.
- Your app version, operating system, device type and how you connected.
- A random identifier for this installation.
- A scrambled form of your account ID if you sign in to Codex with ChatGPT or to
  Claude. It lets us recognize one person across computers. We can't turn it back
  into your account ID, and we don't receive your name or email.

## What is never collected

Prompts, responses, file contents, file names and paths, URLs, email addresses,
research results, credentials and raw provider events. Scient drops any value that
looks like a path, link or email address before it leaves your computer. The Usage
page's wider local history stays on your computer.

## Turning it off

There is no setting for this in the app. To stop sending usage data, set
`SCIENT_ANALYTICS_ENABLED=false` in the environment before starting Scient.

An administrator can turn it off for every user on a machine with a
[managed policy](./managed-policy.md#other-capabilities).
