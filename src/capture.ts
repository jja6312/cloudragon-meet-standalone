import type { Source, AudioDiagnostics } from "./model";

export class Capture {
  private streams: MediaStream[] = [];
  private context?: AudioContext;
  private mixed?: MediaStreamAudioDestinationNode;
  private worklet?: AudioWorkletNode;
  private recorder?: MediaRecorder;
  private closed = false;
  private started = 0;
  private pausedAt = 0;
  private pausedMs = 0;
  private stoppedElapsed?: number;
  private flush?: () => void;
  private onPcm?: (data: ArrayBuffer) => void;
  private stopping?: Promise<void>;
  private recordingStream?: MediaStream;
  diagnostics?: AudioDiagnostics;
  mimeType = "";
  get elapsed() {
    return (
      this.stoppedElapsed ??
      (this.started
        ? Math.max(
            0,
            (this.pausedAt || performance.now()) - this.started - this.pausedMs,
          )
        : 0)
    );
  }

  async prepare(
    source: Source,
    onLevel: (value: number) => void,
    onEnded: () => void,
    profile: "natural" | "voice" = "natural",
  ) {
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "HTTPS로 접속한 최신 Chrome 또는 Edge에서 열어 주세요.",
        );
      if (source !== "mic") {
        if (!navigator.mediaDevices.getDisplayMedia)
          throw new Error(
            "이 기기는 공유 소리를 지원하지 않습니다. 마이크 입력을 선택해 주세요.",
          );
        // First awaited operation: the picker must retain the start button's user activation.
        const displayOptions: DisplayMediaStreamOptions & {
          selfBrowserSurface: "exclude";
          systemAudio: "include";
          windowAudio: "window";
        } = {
          // Hints only: the browser and OS still decide which audio sources exist.
          // Prefer a different browser tab (the most reliable audio-sharing path)
          // while keeping window/monitor choices available to the user.
          video: { displaySurface: "browser" },
          audio: true,
          selfBrowserSurface: "exclude",
          systemAudio: "include",
          windowAudio: "window",
        };
        const stream =
          await navigator.mediaDevices.getDisplayMedia(displayOptions);
        this.add(stream);
        if (!stream.getAudioTracks().length)
          throw new Error(
            "공유 소리를 받지 못했습니다. Chrome/Edge 공유 창에서 소리가 재생되는 탭과 '탭 오디오 공유'를 선택해 다시 시작해 주세요. 화면/창 오디오는 브라우저·OS에 따라 제공되지 않을 수 있습니다.",
          );
        // Keep the video track alive until stop; stopping it can terminate browser audio sharing.
        // Only audio tracks enter Web Audio / MediaRecorder / the speech connection.
      }
      if (source !== "shared") {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
              echoCancellation: profile === "voice" || source === "both",
              noiseSuppression: profile === "voice",
              autoGainControl: profile === "voice",
              sampleRate: { ideal: 48000 },
            },
          });
        } catch (error) {
          if (
            error instanceof DOMException &&
            ["NotReadableError", "OverconstrainedError"].includes(error.name) &&
            (await navigator.mediaDevices.enumerateDevices()).some(
              (d) => d.kind === "audioinput",
            )
          )
            stream = await navigator.mediaDevices.getUserMedia({
              video: false,
              audio: true,
            });
          else throw error;
        }
        this.add(stream);
      }
      this.context = new AudioContext({ sampleRate: 48000 });
      this.mixed = this.context.createMediaStreamDestination();
      const gain = this.context.createGain();
      gain.gain.value = 1 / this.streams.length;
      for (const stream of this.streams) {
        for (const track of stream.getTracks()) track.onended = onEnded;
        this.context
          .createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
          .connect(gain);
      }
      gain.connect(this.mixed);
      // Preserve the original microphone/shared audio when no mixing is required.
      // The parallel Web Audio branch is only for level metering and speech PCM.
      this.recordingStream =
        this.streams.length === 1
          ? new MediaStream(this.streams[0].getAudioTracks())
          : this.mixed.stream;
      const settings = this.recordingStream.getAudioTracks()[0]?.getSettings();
      this.diagnostics = {
        path: this.streams.length === 1 ? "direct" : "mixed",
        requestedBitrate: 192000,
        sampleRate: this.context.sampleRate,
        channels: settings?.channelCount,
        echoCancellation: settings?.echoCancellation,
        noiseSuppression: settings?.noiseSuppression,
        autoGainControl: settings?.autoGainControl,
      };
      await this.context.audioWorklet.addModule("/pcm-worklet.js");
      if (this.closed) throw new DOMException("취소됨", "AbortError");
      this.worklet = new AudioWorkletNode(this.context, "meet-pcm");
      this.worklet.port.onmessage = ({ data }) => {
        if (data.flushed) {
          this.flush?.();
          return;
        }
        onLevel(data.level);
        if (this.started && !this.pausedAt) this.onPcm?.(data.pcm);
      };
      gain.connect(this.worklet);
      this.worklet.connect(this.context.destination);
      this.mimeType =
        [
          "audio/webm;codecs=opus",
          "audio/mp4",
          "audio/webm",
          "audio/ogg;codecs=opus",
        ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
      if (!this.mimeType)
        throw new Error(
          "이 브라우저의 녹음 형식을 지원하지 않습니다. Chrome 또는 Edge를 사용해 주세요.",
        );
      await this.context.resume();
    } catch (error) {
      await this.stop();
      throw captureError(error);
    }
  }
  private add(stream: MediaStream) {
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      throw new DOMException("취소됨", "AbortError");
    }
    this.streams.push(stream);
  }
  begin(
    onBlob: (blob: Blob) => void,
    onPcm: (pcm: ArrayBuffer) => void,
    onError: () => void,
  ) {
    if (this.closed || !this.recordingStream)
      throw new Error("오디오 입력이 준비되지 않았습니다.");
    if (
      this.streams.some((stream) =>
        stream.getAudioTracks().some((track) => track.readyState !== "live"),
      )
    )
      throw new Error("오디오 공유가 종료됐습니다. 다시 시작해 주세요.");
    this.onPcm = onPcm;
    this.recorder = new MediaRecorder(this.recordingStream, {
      mimeType: this.mimeType,
      audioBitsPerSecond: 192000,
    });
    if (this.diagnostics)
      this.diagnostics.actualBitrate = this.recorder.audioBitsPerSecond;
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) onBlob(e.data);
    };
    this.recorder.onerror = onError;
    this.started = performance.now();
    this.recorder.start(5000);
  }
  async pause() {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pausedAt = performance.now();
      await this.context?.suspend();
    }
  }
  async resume() {
    if (this.recorder?.state === "paused") {
      await this.context?.resume();
      this.pausedMs += performance.now() - this.pausedAt;
      this.pausedAt = 0;
      this.recorder.resume();
    }
  }
  flushForBackground() {
    // Best effort only: the OS may freeze the page before this event is delivered.
    if (this.recorder?.state === "recording") {
      try {
        this.recorder.requestData();
      } catch {
        /* stop may already be in flight */
      }
    }
  }
  async restoreAfterVisibility() {
    // Never resume an explicit user pause or resurrect a stopped capture.
    if (this.closed || this.pausedAt || this.recorder?.state !== "recording")
      return;
    if (this.context && this.context.state !== "running")
      await this.context.resume();
  }
  stop() {
    this.stoppedElapsed ??= this.elapsed;
    this.closed = true;
    return (this.stopping ??= this.close());
  }
  private async close() {
    for (const stream of this.streams)
      for (const track of stream.getTracks()) track.onended = null;
    if (this.recorder && this.recorder.state !== "inactive") {
      const recorder = this.recorder;
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    if (this.context?.state === "running" && this.worklet) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.flush = () => {
          clearTimeout(timer);
          resolve();
        };
        this.worklet!.port.postMessage("flush");
      });
    }
    this.onPcm = undefined;
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    this.mixed?.stream.getTracks().forEach((t) => t.stop());
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
    }
    await this.context?.close().catch(() => {});
  }
}
function captureError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return new Error(
        "마이크 또는 화면 공유가 허용되지 않았습니다. 주소창의 사이트 권한을 확인해 주세요.",
      );
    if (error.name === "NotFoundError")
      return new Error(
        "마이크를 찾지 못했습니다. 입력 장치를 연결하고 다시 시작해 주세요.",
      );
    if (error.name === "NotReadableError")
      return new Error(
        "오디오 장치를 시작하지 못했습니다. 연결·드라이버·다른 앱의 사용 상태를 확인해 주세요.",
      );
  }
  return error;
}
