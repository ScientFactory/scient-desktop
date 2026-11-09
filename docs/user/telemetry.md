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
  into your account ID.
- With account analytics activated, the email supplied by a provider sign-in,
  its reported plan when available, and the model services connected in Scient
  Agent. Browser-profile emails and saved website logins are excluded.
- A hashed operating-system machine ID, to associate installations on the same
  computer. Shared devices and shared accounts do not prove one individual.
- The optional work, field and role answers in Getting Started. Existing users
  can answer or dismiss the question once.
- With account analytics activated, the gateway records the upload IP address,
  approximate country, region, city, time zone and network. Shared-IP download
  matches are tentative associations.

## What is never collected

Prompts, responses, file contents, file names and paths, URLs, research results,
passwords, API keys, access tokens and raw provider events. Email is accepted
only on the dedicated provider-account observation; ordinary usage events
continue to reject email, paths and links. The Usage
page's wider local history stays on your computer.

## Turning it off

There is no setting for this in the app. To stop sending usage data, set
`SCIENT_ANALYTICS_ENABLED=false` in the environment before starting Scient.

An administrator can turn it off for every user on a machine with a
[managed policy](./managed-policy.md#other-capabilities).

## Storage and retention

Provider emails, work-profile answers, hashed machine IDs and network observations
stay in Scient's Cloudflare database and are excluded from PostHog exports.
Usage history is kept while an installation remains active, then expires two years
after its last activity; diagnostics expire after 60 days. Daily totals without
installation or account identifiers are kept permanently. A token-authenticated
gateway deletion request removes the installation's records and observations;
it does not authorize deleting other installations that share an account or IP.

The additional collection is disabled at the gateway until the updated privacy
notice is published and activation is recorded. A code merge does not activate
collection or release a new desktop version.
