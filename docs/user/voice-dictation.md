# Voice dictation

Scient desktop transcribes a short voice recording with ChatGPT or on the local
computer. You can optionally ask the selected AI provider to correct the
resulting transcript text before Scient inserts or sends it.

1. Select the microphone in the chat composer.
2. On first use, Scient shows how it can transcribe:
   - **ChatGPT**, listed first when Scient Agent or Codex is signed in to
     ChatGPT. Nothing is downloaded. See [Dictate with ChatGPT](#dictate-with-chatgpt).
   - A local model: **Multilingual Small** for faster setup,
     **Multilingual Medium** for higher expected accuracy, or
     **Multilingual Turbo** for the most demanding dictation on a powerful
     computer. Scient downloads and verifies the selected model. You can
     cancel setup and resume the download later.

   Scient remembers your choice. If a local model is already set up, Scient
   keeps using it and does not ask.

3. Allow microphone access when macOS, Windows, or Linux asks.
4. While recording, choose cancel, insert the transcript, or transcribe and
   send. `Esc` cancels and `Enter` inserts.

If microphone access was denied on macOS, select **Open Settings** beside the
voice error, enable Scient under **Privacy & Security → Microphone**, then quit
and reopen Scient. A downloaded model does not itself grant microphone access.
If the Mac restricts microphone access through parental controls or device
management, those restrictions must be resolved before recording can start.

Dictation continues the current draft without forcing a new line. Existing
spaces and paragraph breaks you entered are preserved. Speech-recognition
segment boundaries do not introduce paragraph breaks.

With a local model, audio and the initial transcript are processed by a bundled
local speech model. Audio remains on the local computer and is never sent to
Scient or an AI provider.

## Dictate with ChatGPT

If Scient Agent or Codex is signed in to ChatGPT, you can dictate with ChatGPT
instead of a local model: choose **ChatGPT** the first time you use the
microphone, or later in **Settings → Voice**. Nothing is downloaded, and it
works the same on any computer, however old. Each recording is uploaded with
your ChatGPT sign-in to ChatGPT's own dictation service, the one the ChatGPT and
Codex apps use, and the text comes back to your draft.

The recording leaves your computer and goes to OpenAI, which keeps it for 30
days, as it does for dictation in its own apps. Your ChatGPT plan's terms apply.
Nothing is sent until you choose ChatGPT. Dictation with ChatGPT needs an
internet connection, and through Scient Agent it needs version 0.1.9 or newer.
If the sign-in ends, Scient asks you to sign in again rather than switching to
a local model.

**Correct transcripts with an LLM** in **Settings → Voice** is off by default.
When it remains off, the transcript stays local. When you turn it on, Scient
sends the transcript text—not the recording—to the selected, authenticated AI
provider, together with the selected language when one is set. While correction
is pending, you can use the original local transcript immediately. If the
provider is unavailable, unsupported, not authenticated, times out, or returns
an invalid correction, Scient falls back to the exact local transcript.

The model download, dictation with ChatGPT and an enabled provider correction
are therefore the possible network paths for voice dictation. Provider correction follows that
provider's own service and data-handling terms.

Voice dictation is available in the desktop app. The macOS voice runtime
requires macOS 12 or newer. A recording is limited to three minutes. If no
speech is detected, Scient leaves the draft unchanged.

To change models later, open **Settings → Voice**. The page shows which model
is recommended for the current machine, which model is in use, download
progress, and removal controls.
