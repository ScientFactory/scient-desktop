# Voice dictation

Scient desktop transcribes a short voice recording on the local computer. You
can optionally ask the selected AI provider to correct the resulting transcript
text before Scient inserts or sends it.

1. Select the microphone in the chat composer.
2. On first use, choose **Multilingual Small** for faster setup,
   **Multilingual Medium** for higher expected accuracy, or
   **Multilingual Turbo** for the most demanding dictation on a powerful
   computer. Scient downloads and verifies the selected local model. You can
   cancel setup and resume the download later.
3. Allow microphone access when macOS, Windows, or Linux asks.
4. While recording, choose cancel, insert the transcript, or transcribe and
   send. `Esc` cancels and `Enter` inserts.

Audio and the initial transcript are processed by the bundled local whisper.cpp
runtime. Audio is never sent to Scient, T3, or an AI provider.

**Correct transcripts with an LLM** in **Settings → Voice** is off by default.
When it remains off, the transcript stays local. When you turn it on, Scient
sends the transcript text—not the recording—to the selected, authenticated AI
provider, together with the selected language when one is set. While correction
is pending, you can use the original local transcript immediately. If the
provider is unavailable, unsupported, not authenticated, times out, or returns
an invalid correction, Scient falls back to the exact local transcript.

The model download and an enabled provider correction are therefore the two
possible network paths for voice dictation. Provider correction follows that
provider's own service and data-handling terms.

Voice dictation currently belongs to the desktop app. Browser and mobile
clients do not show the microphone because they do not have a local desktop
runtime. The macOS voice runtime requires macOS 12 or newer. A recording is
limited to three minutes. If no speech is detected, Scient leaves the draft
unchanged.

To change models later, open **Settings → Voice**. The page shows which model
is recommended for the current machine, which model is in use, download
progress, and removal controls.
