# Notification system design QA

## Scope

The notification cleanup routes durable background work and attention requests into the lower-left Activity Center, keeps short-lived confirmations local to the initiating surface, and reserves the centered snackbar for reversible actions.

## Visual evidence

- [Empty Activity Center](activity-empty.jpg)
- [Needs-attention Activity Center](activity-needs-attention.jpg)

Both captures use the current Scient shell at 1672 x 941 CSS pixels in light mode. The needs-attention state was produced by intentionally disconnecting an isolated local development server, then reconnecting it.

## Findings resolved

- Replaced the old centered reconnect notification card with a persistent Activity item.
- Increased Activity panel width and secondary-text legibility for realistic diagnostic copy.
- Strengthened unresolved Activity summaries without turning the sidebar row into a disruptive alert.
- Added reduced-motion handling to the in-progress spinner.
- Preserved semantic buttons for unread handling, diagnostics, navigation, and dismissal.

## Evidence limits

- Native operating-system notification appearance depends on the host platform and was not captured here.
- Screen-reader announcements, high-contrast mode, and long multi-item production histories remain separate acceptance checks.
