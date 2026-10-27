// AudioWorklet modules obey script-src, so CSP requires a same-origin asset rather than a blob URL.
// Keep the registered name synchronized with VOICE_WORKLET_PROCESSOR_NAME. Round chunks to whole
// samples at the actual rate to maintain the 20 Hz waveform cadence.

const CHUNK_SAMPLES = Math.round(sampleRate / 20);

class ScientVoiceRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(CHUNK_SAMPLES);
    this._offset = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || message.type !== "flush") return;
      this._flush();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort.postMessage has no targetOrigin parameter.
      this.port.postMessage({ type: "flushed", requestId: message.requestId });
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this._buffer[this._offset] = channel[i];
      this._offset += 1;
      if (this._offset >= this._buffer.length) this._flush();
    }
    return true;
  }

  _flush() {
    if (this._offset === 0) return;
    const chunk = this._buffer.slice(0, this._offset);
    let sumOfSquares = 0;
    for (let i = 0; i < chunk.length; i += 1) sumOfSquares += chunk[i] * chunk[i];
    const rms = chunk.length > 0 ? Math.sqrt(sumOfSquares / chunk.length) : 0;
    this.port.postMessage({ type: "samples", samples: chunk, rms: rms }, [chunk.buffer]);
    this._offset = 0;
  }
}

registerProcessor("scient-voice-recorder", ScientVoiceRecorderProcessor);
