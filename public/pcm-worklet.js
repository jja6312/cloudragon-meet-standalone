class MeetPcm extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.port.onmessage = ({data}) => { if (data === 'flush') { this.flush(); this.port.postMessage({flushed: true}); } }; }
  flush() {
    if (!this.samples.length) return;
    const output = new Int16Array(this.samples.length);
    let sum = 0;
    this.samples.forEach((sample, i) => { const value = Math.max(-1, Math.min(1, sample)); output[i] = value < 0 ? value * 32768 : value * 32767; sum += value * value; });
    this.samples = [];
    this.port.postMessage({pcm: output.buffer, level: Math.sqrt(sum / output.length)}, [output.buffer]);
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (channels?.[0]) for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i];
      this.samples.push(sample / channels.length);
    }
    if (this.samples.length >= sampleRate / 10) this.flush();
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('meet-pcm', MeetPcm);
