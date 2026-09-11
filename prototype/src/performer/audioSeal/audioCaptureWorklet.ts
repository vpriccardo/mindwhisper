/**
 * AudioWorkletProcessor: collect mono PCM chunks and post to main thread.
 * Keep this file free of heavy imports — built as a separate worklet bundle.
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
  private _chunkSize: number;
  private _buf: Float32Array;
  private _pos = 0;
  private _dropped = 0;

  constructor() {
    super();
    this._chunkSize = 960; // 20 ms at 48 kHz
    this._buf = new Float32Array(this._chunkSize);
    this.port.onmessage = (ev) => {
      const data = ev.data as { type?: string; chunkSize?: number };
      if (data?.type === "config" && data.chunkSize) {
        this._chunkSize = data.chunkSize;
        this._buf = new Float32Array(this._chunkSize);
        this._pos = 0;
      }
    };
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _params: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    // Mix down if multi-channel
    const frames = ch0.length;
    for (let i = 0; i < frames; i++) {
      let s = ch0[i]!;
      if (input.length > 1) {
        let acc = s;
        for (let c = 1; c < input.length; c++) acc += input[c]![i]!;
        s = acc / input.length;
      }
      this._buf[this._pos++] = s;
      if (this._pos >= this._chunkSize) {
        const copy = this._buf.slice(0);
        try {
          this.port.postMessage({ type: "pcm", samples: copy }, [copy.buffer]);
        } catch {
          this._dropped++;
          this.port.postMessage({ type: "dropped", count: this._dropped });
        }
        this._pos = 0;
        this._buf = new Float32Array(this._chunkSize);
      }
    }
    return true;
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
