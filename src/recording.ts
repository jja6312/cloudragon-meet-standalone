import { apiRequest, apiUpload } from "./api";
import { Capture } from "./capture";
import {
  draftKey,
  pendingChunks,
  removeChunk,
  removeDraft,
  saveChunk,
  saveDraft,
} from "./drafts";
import { Speech } from "./speech";
import { MAX_RECORDING_MS } from "./limits";
import { TranslationPlayback } from "./playback";
import {
  errorText,
  meetingPath,
  type Document,
  type Draft,
  type Meeting,
  type Row,
} from "./model";

export type RecordingState =
  | "preparing"
  | "live"
  | "paused"
  | "saving"
  | "pending"
  | "complete"
  | "discarded"
  | "failed";
export type RecordingView = {
  state: RecordingState;
  meeting?: Meeting;
  level: number;
  notice: string;
  inputWarning?: string;
  speechLost: boolean;
  pending: number;
  wakeLock?: "requesting" | "active" | "released" | "unsupported" | "denied";
  backgroundRisk?: boolean;
  playbackBlocked?: boolean;
  playbackNotice?: string;
  nativeCapture?: boolean;
  nativeTranscriptionPendingMs?: number;
  discardRequested?: boolean;
};

/** One owner for capture, durable chunks, server revision, and finalization. */
export class Recording {
  private capture?: Capture;
  private speech?: Speech;
  private playback?: TranslationPlayback;
  private draft?: Draft;
  private view: RecordingView = {
    state: "preparing",
    level: 0,
    notice: "",
    speechLost: false,
    pending: 0,
  };
  private disk: Promise<void> = Promise.resolve();
  private syncTask?: Promise<void>;
  private stopTask?: Promise<void>;
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private checkpointTick = 0;
  private wakeLock?: WakeLockSentinel;
  private wakeTask?: Promise<void>;
  private speechRetryTimer?: ReturnType<typeof setTimeout>;
  private speechRetryAttempt = 0;
  private speechRetryable = true;
  private speechReconnectTask?: Promise<void>;
  private speechOnlineListener?: () => void;
  private cancelled = false;
  private storageFailed = false;
  constructor(
    private subject: string,
    private workspace: string,
    private emit: (view: RecordingView) => void,
  ) {}
  private update(values: Partial<RecordingView> = {}) {
    this.view = {
      ...this.view,
      ...values,
      meeting: this.draft
        ? {
            ...this.draft.meeting,
            document: { ...this.draft.meeting.document },
          }
        : this.view.meeting,
    };
    this.emit(this.view);
  }
  async start(title: string, settings: Document) {
    const capture = (this.capture = new Capture());
    let lastSharedSoundMs = 0;
    try {
      await capture.prepare(
        settings.source,
        (level) => {
          if (settings.source !== "shared") {
            this.update({ level });
            return;
          }
          const elapsed = capture.elapsed;
          if (level > 0.002) {
            lastSharedSoundMs = elapsed;
            this.update({ level, inputWarning: undefined });
          } else if (elapsed - lastSharedSoundMs >= 8000) {
            this.update({
              level,
              inputWarning:
                "공유 오디오 입력이 감지되지 않습니다. 공유한 탭에서 소리를 재생하고, 계속 조용하면 '탭 오디오 공유'를 켜서 다시 시작해 주세요.",
            });
          } else {
            this.update({ level });
          }
        },
        () => {
          void this.finish();
        },
        settings.audioProfile,
      );
      if (this.cancelled) throw new Error("녹음을 취소했습니다.");
      const meeting = await apiRequest<Meeting>(
        meetingPath(this.workspace),
        "POST",
        {
          id: crypto.randomUUID(),
          title,
          mimeType: capture.mimeType,
          document: { ...settings, audioDiagnostics: capture.diagnostics },
        },
      );
      this.draft = {
        key: draftKey(this.subject, this.workspace, meeting.id),
        subject: this.subject,
        workspace: this.workspace,
        meeting,
        nextSequence: 0,
        stopped: false,
      };
      if (settings.speakTranslation)
        this.playback = new TranslationPlayback(
          this.workspace,
          meeting.id,
          (message, blocked) =>
            this.update({ playbackNotice: message, playbackBlocked: blocked }),
        );
      await saveDraft(this.draft);
      if (settings.transcribe || settings.mode === "translate") {
        try {
          await this.connectSpeech();
        } catch (error) {
          // Live transcription is optional to preserving the original audio.
          this.speech?.abort();
          this.speech = undefined;
          this.draft.meeting.document.transcriptIncomplete = true;
          this.update({
            speechLost: true,
            notice:
              "실시간 전사 연결을 복구하는 중입니다. 음성 녹음은 계속됩니다. " +
              errorText(error),
          });
        }
      }
      if (this.cancelled) throw new Error("녹음을 취소했습니다.");
      capture.begin(
        (blob) => this.acceptBlob(blob),
        (data) => this.speech?.send(data),
        () => {
          this.update({
            notice: "브라우저 녹음이 중단됐습니다. 수집된 구간을 저장합니다.",
          });
          void this.finish();
        },
      );
      this.draft.meeting.document.audioDiagnostics = capture.diagnostics;
      this.update({ state: "live" });
      if (this.view.speechLost) this.scheduleSpeechReconnect();
      if (document.visibilityState === "visible") void this.requestWakeLock();
      else void this.visibilityChanged();
      this.timer = setInterval(() => {
        if (!this.draft) return;
        this.draft.meeting.document.durationMs = Math.floor(capture.elapsed);
        this.update();
        if (++this.checkpointTick % 5 === 0) {
          this.checkpoint();
          void this.sync().catch((error) =>
            this.update({
              notice: errorText(error) + " 기기에 임시 보관 중입니다.",
            }),
          );
        }
        if (capture.elapsed >= MAX_RECORDING_MS) void this.finish();
      }, 1000);
    } catch (error) {
      this.clearSpeechReconnect();
      await capture.stop();
      this.speech?.abort();
      this.playback?.stop();
      await this.releaseWakeLock();
      if (this.draft) {
        this.draft.stopped = true;
        await saveDraft(this.draft).catch(() => {});
      }
      this.update({ state: "failed", notice: errorText(error) });
    }
  }
  private acceptBlob(blob: Blob) {
    // A locked mobile screen may deliver a much larger blob than timeslice requests.
    // Slice bytewise; the server concatenates in order to retain the original container.
    for (let offset = 0; offset < blob.size; offset += 2 * 1024 * 1024) {
      const part = blob.slice(offset, offset + 2 * 1024 * 1024);
      const sequence = this.sequence++;
      this.disk = this.disk
        .then(async () => {
          if (!this.draft) return;
          const next = { ...this.draft, nextSequence: sequence + 1 };
          await saveChunk(next, sequence, part);
          this.draft.nextSequence = sequence + 1;
          this.update({ pending: this.view.pending + 1 });
        })
        .catch((error) => {
          this.storageFailed = true;
          this.update({ notice: errorText(error) });
          void this.finish();
          throw error;
        });
      // Keep the promise observable without an unhandled rejection while stop drains it.
      void this.disk.catch(() => {});
    }
    // A previous sync may have already scanned its chunk list when this blob arrives.
    // Wait for both the durable write and that sync, then start another pass so the
    // new audio does not sit until the next periodic checkpoint.
    const written = this.disk;
    void written
      .then(async () => {
        await this.syncTask?.catch(() => {});
        if (!this.cancelled) await this.sync();
      })
      .catch((error) =>
        this.update({
          notice: errorText(error) + " 기기 임시본은 유지됩니다.",
        }),
      );
  }
  private checkpoint() {
    this.disk = this.disk.then(async () => {
      if (this.draft) await saveDraft(this.draft);
    });
    void this.disk.catch((error) => {
      this.storageFailed = true;
      this.update({ notice: errorText(error) });
      void this.finish();
    });
  }
  private async synchronize() {
    await this.disk;
    if (!this.draft || this.cancelled) return;
    const path = meetingPath(this.workspace, this.draft.meeting.id);
    for (const chunk of await pendingChunks(this.draft.key)) {
      await apiUpload(path + "/chunks/" + chunk.sequence, chunk.blob);
      await removeChunk(chunk.key);
      this.update({ pending: Math.max(0, this.view.pending - 1) });
    }
    const meeting = await apiRequest<Meeting>(path, "PUT", {
      revision: this.draft.meeting.revision,
      title: this.draft.meeting.title,
      document: this.draft.meeting.document,
    });
    this.draft.meeting.revision = meeting.revision;
    this.draft.meeting.chunks = meeting.chunks;
    this.checkpoint();
    await this.disk;
    this.update();
  }
  sync() {
    return (this.syncTask ??= this.synchronize().finally(() => {
      this.syncTask = undefined;
    }));
  }
  async pause() {
    if (this.view.state !== "live") return;
    await this.capture?.pause();
    this.update({ state: "paused" });
    await this.releaseWakeLock();
    this.checkpoint();
  }
  async resume() {
    if (this.view.state !== "paused") return;
    await this.capture?.resume();
    this.update({ state: "live" });
    void this.requestWakeLock();
  }
  bookmark(id: string) {
    if (!this.draft) return;
    this.draft.meeting.document.rows = this.draft.meeting.document.rows.map(
      (r) => (r.id === id ? { ...r, bookmark: !r.bookmark } : r),
    );
    this.update();
    this.checkpoint();
  }
  private rows(rows: Row[], retained: Row[] = []) {
    if (!this.draft) return;
    const current = new Map(
      this.draft.meeting.document.rows.map((row) => [row.id, row]),
    );
    rows.forEach((row) =>
      current.set(row.id, {
        ...row,
        bookmark: current.get(row.id)?.bookmark ?? false,
      }),
    );
    this.draft.meeting.document.rows = [
      ...retained.map((r) => current.get(r.id) ?? r),
      ...rows.map((r) => current.get(r.id)!),
    ].sort((a, b) => a.startMs - b.startMs);
    this.update();
  }
  setOutputDevice(deviceId: string) {
    return this.playback?.setOutputDevice(deviceId);
  }
  enablePlayback() {
    this.playback?.enable();
  }
  playTranslation(rowId: string) {
    const document = this.draft?.meeting.document;
    if (
      !document?.speakTranslation ||
      !["live", "paused"].includes(this.view.state)
    )
      return;
    const row = document.rows.find((row) => row.id === rowId);
    if (
      !row ||
      row.provisional ||
      row.originalLanguage !== "ko" ||
      row.translationLanguage !== document.sourceLanguage
    )
      return;
    this.playback?.enqueue(row.translation);
  }
  private clearSpeechReconnect() {
    if (this.speechRetryTimer) clearTimeout(this.speechRetryTimer);
    this.speechRetryTimer = undefined;
    if (this.speechOnlineListener)
      window.removeEventListener("online", this.speechOnlineListener);
    this.speechOnlineListener = undefined;
  }
  private abortSpeech() {
    this.speech?.abort();
    this.speech = undefined;
  }
  private scheduleSpeechReconnect() {
    if (
      this.cancelled ||
      !this.speechRetryable ||
      !["live", "paused"].includes(this.view.state) ||
      this.speechRetryTimer ||
      this.speechReconnectTask ||
      this.speechOnlineListener
    )
      return;
    if (!navigator.onLine) {
      this.speechOnlineListener = () => {
        this.speechOnlineListener = undefined;
        this.scheduleSpeechReconnect();
      };
      window.addEventListener("online", this.speechOnlineListener, {
        once: true,
      });
      return;
    }
    const delay = Math.min(
      15_000,
      1000 * 2 ** Math.min(this.speechRetryAttempt++, 4),
    );
    this.speechRetryTimer = setTimeout(() => {
      this.speechRetryTimer = undefined;
      void this.reconnect();
    }, delay);
  }
  private reconnect() {
    if (this.speechReconnectTask) return this.speechReconnectTask;
    if (this.cancelled || !["live", "paused"].includes(this.view.state))
      return Promise.resolve();
    this.speechReconnectTask = (async () => {
      this.speech?.abort();
      this.speech = undefined;
      try {
        await this.connectSpeech(Math.floor(this.capture?.elapsed ?? 0));
        if (this.cancelled || !["live", "paused"].includes(this.view.state))
          return;
        this.speechRetryAttempt = 0;
        this.speechRetryable = true;
        this.update({
          speechLost: false,
          notice:
            "전사가 자동으로 다시 연결됐습니다. 중단 구간은 원음을 확인해 주세요.",
        });
      } catch (error) {
        if (this.cancelled || !["live", "paused"].includes(this.view.state))
          return;
        this.abortSpeech();
        if (this.draft) this.draft.meeting.document.transcriptIncomplete = true;
        this.update({
          speechLost: true,
          notice: "전사 연결을 자동 재시도하는 중입니다. " + errorText(error),
        });
      }
    })().finally(() => {
      this.speechReconnectTask = undefined;
      if (this.view.speechLost) this.scheduleSpeechReconnect();
    });
    return this.speechReconnectTask;
  }
  private async connectSpeech(offset = 0) {
    if (!this.draft) return;
    const token = await apiRequest<{ apiKey: string; websocketUrl: string }>(
      meetingPath(this.workspace, this.draft.meeting.id) + "/speech-token",
      "POST",
    );
    if (
      this.cancelled ||
      !["preparing", "live", "paused"].includes(this.view.state)
    )
      return;
    const retained = [...this.draft.meeting.document.rows];
    const speech = new Speech(
      (rows) => {
        if (
          this.speech === speech &&
          !this.cancelled &&
          ["live", "paused", "saving"].includes(this.view.state)
        )
          this.rows(rows, retained);
      },
      (notice, retryable) => {
        if (
          this.speech !== speech ||
          this.cancelled ||
          !["preparing", "live", "paused", "saving"].includes(this.view.state)
        )
          return;
        this.speechRetryable = retryable;
        if (this.draft) this.draft.meeting.document.transcriptIncomplete = true;
        const recording = ["preparing", "live", "paused"].includes(
          this.view.state,
        );
        this.update({
          notice:
            retryable && recording
              ? notice + " 자동으로 다시 연결합니다."
              : notice,
          speechLost: true,
        });
        if (recording) this.scheduleSpeechReconnect();
      },
      offset,
    );
    this.speech = speech;
    await speech.connect(token, this.draft.meeting.document);
  }
  finish() {
    return (this.stopTask ??= this.stop().finally(() => {
      this.stopTask = undefined;
    }));
  }
  private async stop() {
    if (!this.draft || this.view.state === "complete") return;
    this.clearSpeechReconnect();
    clearInterval(this.timer);
    this.update({ state: "saving" });
    const duration = this.capture?.elapsed;
    await this.capture?.stop();
    await this.speech?.finish();
    await this.playback?.finish();
    await this.releaseWakeLock();
    if (duration !== undefined && duration > 0)
      this.draft.meeting.document.durationMs = Math.floor(duration);
    this.draft.stopped = true;
    try {
      this.checkpoint();
      await this.disk;
      if (this.storageFailed)
        throw new Error(
          "일부 녹음 조각을 기기에 저장하지 못했습니다. 자동 완료하지 않았습니다. 복구 목록에서 보관된 구간을 확인해 주세요.",
        );
      await this.syncTask;
      await this.sync();
      const pending = await pendingChunks(this.draft.key);
      if (pending.length)
        throw new Error("아직 전송되지 않은 녹음 조각이 있습니다.");
      this.draft.meeting = await apiRequest<Meeting>(
        meetingPath(this.workspace, this.draft.meeting.id) + "/complete",
        "POST",
        {
          chunks: this.draft.nextSequence,
          revision: this.draft.meeting.revision,
        },
      );
      await removeDraft(this.draft.key);
      const speechRequested =
        this.draft.meeting.document.transcribe ||
        this.draft.meeting.document.mode === "translate";
      const saved =
        speechRequested && this.draft.meeting.document.transcriptIncomplete
          ? "녹음을 저장했습니다. 전사가 일부 누락됐을 수 있어 원음을 확인해 주세요."
          : speechRequested
            ? "녹음과 전사를 저장했습니다."
            : "녹음을 저장했습니다.";
      this.update({
        state: "complete",
        pending: 0,
        notice: saved,
      });
    } catch (error) {
      this.update({
        state: "pending",
        notice: errorText(error) + " 연결을 확인한 뒤 저장을 다시 시도하세요.",
      });
    }
  }
  async recover(draft: Draft) {
    if (draft.discardRequested) {
      this.draft = draft;
      await this.discard();
      return;
    }
    if (!draft.stopped && draft.meeting.document.transcribe)
      draft.meeting.document.transcriptIncomplete = true;
    this.draft = draft;
    this.sequence = draft.nextSequence;
    this.update({ state: "saving" });
    try {
      const current = await apiRequest<Meeting>(
        meetingPath(this.workspace, draft.meeting.id),
      );
      if (current.state === "COMPLETED") {
        this.draft.meeting = current;
        await removeDraft(draft.key);
        this.update({
          state: "complete",
          notice: "서버에 저장된 회의를 확인했습니다.",
        });
        return;
      }
      this.draft.meeting.revision = current.revision;
      this.update({ pending: (await pendingChunks(draft.key)).length });
      await this.finish();
    } catch (error) {
      this.update({ state: "pending", notice: errorText(error) });
    }
  }
  async visibilityChanged() {
    if (this.cancelled || this.view.state !== "live") return;
    if (document.visibilityState !== "visible") {
      // Hidden does not prove a gap, but neither recording nor live STT can be guaranteed.
      if (
        this.draft &&
        (this.draft.meeting.document.transcribe ||
          this.draft.meeting.document.mode === "translate")
      )
        this.draft.meeting.document.transcriptIncomplete = true;
      this.update({ backgroundRisk: true });
      this.capture?.flushForBackground();
      this.checkpoint();
      await this.releaseWakeLock();
      return;
    }
    try {
      await this.capture?.restoreAfterVisibility();
    } catch (error) {
      if (this.cancelled || this.view.state !== "live") return;
      this.update({
        speechLost: true,
        notice: "오디오 처리 재개를 확인하지 못했습니다. " + errorText(error),
      });
    }
    if (!this.cancelled && this.view.state === "live")
      void this.requestWakeLock();
  }
  private async releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = undefined;
    if (!this.cancelled) this.update({ wakeLock: "released" });
    await lock?.release().catch(() => {});
  }
  requestWakeLock(): Promise<void> {
    if (
      this.cancelled ||
      this.view.state !== "live" ||
      document.visibilityState !== "visible"
    )
      return Promise.resolve();
    if (this.wakeLock && !this.wakeLock.released) return Promise.resolve();
    if (this.wakeTask) return this.wakeTask;
    if (!navigator.wakeLock?.request) {
      this.update({ wakeLock: "unsupported" });
      return Promise.resolve();
    }
    this.update({ wakeLock: "requesting" });
    this.wakeTask = (async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (
          this.cancelled ||
          this.view.state !== "live" ||
          document.visibilityState !== "visible"
        ) {
          await lock.release().catch(() => {});
          return;
        }
        this.wakeLock = lock;
        lock.addEventListener(
          "release",
          () => {
            if (this.wakeLock !== lock) return;
            this.wakeLock = undefined;
            this.update({ wakeLock: "released" });
          },
          { once: true },
        );
        this.update({ wakeLock: lock.released ? "released" : "active" });
      } catch {
        if (!this.cancelled && this.view.state === "live")
          this.update({ wakeLock: "denied" });
      }
    })().finally(() => {
      this.wakeTask = undefined;
    });
    return this.wakeTask;
  }
  cancel() {
    this.cancelled = true;
    this.clearSpeechReconnect();
    clearInterval(this.timer);
    this.speech?.abort();
    this.playback?.stop();
    void this.capture?.stop();
    void this.releaseWakeLock();
  }
  async discard() {
    if (!this.draft) return;
    this.cancelled = true;
    this.clearSpeechReconnect();
    clearInterval(this.timer);
    this.update({
      state: "saving",
      discardRequested: true,
      notice: "녹음과 전사를 삭제하고 있습니다.",
    });
    this.speech?.abort();
    this.playback?.stop();
    await this.capture?.stop();
    await this.releaseWakeLock();
    try {
      await this.disk;
      await this.syncTask?.catch(() => {});
      this.draft.stopped = true;
      this.draft.discardRequested = true;
      await saveDraft(this.draft);
      await apiRequest(
        meetingPath(this.workspace, this.draft.meeting.id) + "/discard",
        "POST",
        {},
      );
      await removeDraft(this.draft.key);
      this.draft.meeting.document.rows = [];
      this.draft.meeting.chunks = [];
      this.update({
        state: "discarded",
        notice: "음성과 전사를 삭제했습니다.",
      });
    } catch (error) {
      this.update({
        state: "pending",
        discardRequested: true,
        notice:
          "삭제를 완료하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요. " +
          errorText(error),
      });
    }
  }
}
