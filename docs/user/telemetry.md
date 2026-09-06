# Product usage data

In release builds with analytics available, sharing is on by default unless you
have saved a different preference. Scient does not send usage events to T3's
analytics service.

Where analytics are deliberately enabled, Scient accepts only its registered events and permitted
properties, subject to the configured consent level. Prompts, responses, file contents, credentials,
and raw provider events are not accepted as product analytics.

Product analytics are separate from the usage totals shown inside the app and from local resource
diagnostics. Seeing those totals does not mean they are being uploaded.

Use **Share usage and reliability** in Settings → General → Privacy and analytics
to turn sharing off or on. Sharing covers feature usage, reliability and
analytics-delivery counters; it never includes your conversations, files, or
credentials. **What’s shared?** in Settings explains exclusions, storage and
deletion. The separate sharing notification is currently disabled while its
audience and timing are being decided; this does not disable analytics sharing.

Existing preferences are preserved, including Off and older narrower sharing
levels. The switch is on for any saved sharing level; the information panel
explains a narrower saved choice. Turning it off and back on selects usage,
reliability and delivery counters. Development builds remain disabled unless
explicitly configured for testing.
