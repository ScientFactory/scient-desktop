# Voice dictation

Scient desktop can turn a short voice recording into composer text entirely on
the local computer.

1. Select the microphone in the chat composer.
2. On first use, choose **Multilingual Small** for faster setup,
   **Multilingual Medium** for higher expected accuracy, or
   **Multilingual Turbo** for the most demanding dictation on a powerful
   computer. Scient downloads and verifies the selected local model. You can
   cancel setup and resume the download later.
3. Allow microphone access when macOS, Windows, or Linux asks.
4. While recording, choose cancel, insert the transcript, or transcribe and
   send. `Esc` cancels and `Enter` inserts.

Recordings and transcripts are processed by the bundled local whisper.cpp
runtime. Audio is not sent to Scient, T3, or a transcription provider. The
one-time model download is the only network request made by this feature.

Voice dictation currently belongs to the desktop app. Browser and mobile
clients do not show the microphone because they do not have a local desktop
runtime. The macOS voice runtime requires macOS 12 or newer. A recording is
limited to three minutes. If no speech is detected, Scient leaves the draft
unchanged.

To change models later, open **Settings → Voice**. The page shows which model
is recommended for the current machine, which model is in use, download
progress, and removal controls.
