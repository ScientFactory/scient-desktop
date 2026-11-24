# Scient dictation

The Scient composer and citation controls capture audio and deliver text to the
draft that started the request. The desktop bridge requests operating-system
microphone permission before Chromium capture. The local route sends audio to
the speech service on the desktop environment. The speech service shares its
native worker and installed model catalog with recordings.

The Transcription settings page manages engine choices, models, microphone
input, and cleanup. Words supply recognition hints and spelling preferences.
Cloud dictation uses a configured account-bound engine. ChatGPT dictation
uses the selected eligible Codex connection.

After a successful catalog dictation, Transcription settings can offer to
remove previous local model files from the desktop profile. Removal requires
an explicit action on that card.

See [Transcription](./transcription.md) for the worker and recording job lifecycle.

## Capture and delivery

Each recording owns its microphone stream and audio graph. Cancelling
discards the clip. Stopping flushes the AudioWorklet's final partial frame
before closing the graph. A cancelled permission prompt or setup operation
cannot start a recording when it finishes later.

Insert and Send commit the recorder's final flush, the language and correction
settings, and the environment-scoped draft target. The window-level processing
job keeps running after navigation and can deliver only to the draft that
started it. Send submits through that draft's still-mounted composer. If the
composer is gone, the transcript is saved to the draft for review. Citation
comments and question answers end their dictation when the control unmounts.

Provider correction receives transcript text and an optional language
preference. The original transcript remains available while correction runs
and is delivered if correction fails.
