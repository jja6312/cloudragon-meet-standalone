import { apiBlob } from "./api";
import { meetingPath } from "./model";

/** Plays only phrases selected by a user; audio and text are never cached. */
export class TranslationPlayback {
  private queue: string[] = [];
  private playing = false;
  private stopped = false;
  private blocked = false;
  private outputDevice = "";
  private provider = "";
  private audio?: HTMLAudioElement;
  private pending?: { audio: HTMLAudioElement; url: string };
  private abort?: AbortController;

  constructor(
    private workspace: string,
    private meetingId: string,
    private onStatus: (message: string, blocked: boolean) => void,
  ) {}

  enqueue(text: string) {
    if (this.stopped || !text.trim()) return;
    if (this.queue.length >= 4) {
      this.queue.splice(this.playing || this.pending ? 1 : 0, 1);
      this.onStatus(
        "음성 출력이 지연되어 오래된 번역 한 문장을 건너뛰었습니다.",
        false,
      );
    }
    this.queue.push(text.trim().slice(0, 500));
    void this.drain();
  }

  async setOutputDevice(deviceId: string) {
    this.outputDevice = deviceId;
    if (deviceId && this.audio) {
      if (!("setSinkId" in this.audio))
        throw new Error("이 브라우저는 출력 장치 변경을 지원하지 않습니다.");
      await this.audio.setSinkId(deviceId);
    }
  }

  enable() {
    if (this.stopped) return;
    this.blocked = false;
    this.onStatus("번역 음성 출력을 준비했습니다.", false);
    const pending = this.pending;
    if (!pending) {
      void this.drain();
      return;
    }
    this.pending = undefined;
    this.playing = true;
    // play() is called synchronously in the user's click gesture (mobile autoplay policy).
    const started = pending.audio.play();
    void started
      .then(() => this.waitForEnd(pending.audio))
      .then(() => {
        this.queue.shift();
      })
      .catch(() => {
        this.queue.shift();
        this.onStatus("선택한 장치에서 음성을 재생하지 못했습니다.", false);
      })
      .finally(() => {
        URL.revokeObjectURL(pending.url);
        this.audio = undefined;
        this.playing = false;
        void this.drain();
      });
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    this.abort?.abort();
    this.audio?.pause();
    if (this.pending) URL.revokeObjectURL(this.pending.url);
    this.pending = undefined;
    this.audio = undefined;
  }

  async finish() {
    const deadline = Date.now() + 8000;
    while (
      !this.stopped &&
      !this.blocked &&
      this.queue.length &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    this.stop();
  }

  private async drain() {
    if (this.playing || this.blocked || this.stopped) return;
    this.playing = true;
    try {
      while (this.queue.length && !this.stopped) {
        const text = this.queue[0];
        const abort = (this.abort = new AbortController());
        let url = "";
        try {
          const { blob, provider } = await apiBlob(
            meetingPath(this.workspace, this.meetingId) + "/synthesize",
            { text },
            abort.signal,
          );
          if (this.stopped) return;
          if (provider !== this.provider) {
            this.provider = provider;
            this.onStatus("Soniox에서 번역 음성을 생성합니다.", false);
          }
          url = URL.createObjectURL(blob);
          const audio = (this.audio = new Audio(url));
          if (this.outputDevice) {
            if (!("setSinkId" in audio))
              throw new Error(
                "이 브라우저는 출력 장치 변경을 지원하지 않습니다.",
              );
            await audio.setSinkId(this.outputDevice);
          }
          await audio.play();
          await this.waitForEnd(audio);
          this.queue.shift();
        } catch (error) {
          if (this.stopped || abort.signal.aborted) return;
          if (
            error instanceof DOMException &&
            error.name === "NotAllowedError"
          ) {
            this.blocked = true;
            if (this.audio && url) this.pending = { audio: this.audio, url };
            this.onStatus(
              "브라우저가 자동 재생을 막았습니다. ‘음성 재생 허용’을 눌러 주세요.",
              true,
            );
            return;
          }
          this.queue.shift();
          this.onStatus(
            error instanceof Error
              ? error.message
              : "번역 음성을 재생하지 못했습니다.",
            false,
          );
        } finally {
          if (!this.pending) this.audio = undefined;
          this.abort = undefined;
          if (url && !this.pending) URL.revokeObjectURL(url);
        }
      }
    } finally {
      this.playing = false;
    }
  }
  private waitForEnd(audio: HTMLAudioElement) {
    return new Promise<void>((resolve) => {
      if (audio.ended || audio.error) {
        resolve();
        return;
      }
      const done = () => {
        audio.removeEventListener("ended", done);
        audio.removeEventListener("error", done);
        audio.removeEventListener("pause", done);
        resolve();
      };
      audio.addEventListener("ended", done, { once: true });
      audio.addEventListener("error", done, { once: true });
      audio.addEventListener("pause", done, { once: true });
    });
  }
}
