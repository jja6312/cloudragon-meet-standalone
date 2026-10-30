import type { Document, Row } from "./model";
import { retryableSpeechError } from "./limits";
export type Token = {
  text: string;
  is_final?: boolean;
  translation_status?: string;
  language?: string;
  source_language?: string;
  start_ms?: number;
  end_ms?: number;
  speaker?: string;
};

export class Transcript {
  private rows: Row[] = [];
  private ids: string[] = [];
  private current?: number;
  private segmentStart = 0;
  private connection = crypto.randomUUID();
  constructor(private offset = 0) {}
  ingest(tokens: Token[]) {
    // Final tokens are append-only; a response replaces ALL earlier provisional tokens.
    // Return the whole connection snapshot so withdrawn provisional speakers leave no ghost rows.
    const append = (rows: Row[], token: Token, provisional: boolean) => {
      if (typeof token.text !== "string") return;
      if (["<end>", "<fin>"].includes(token.text)) {
        this.current = undefined;
        this.segmentStart = rows.length;
        return;
      }
      const speaker =
        typeof token.speaker === "string" &&
        /^[A-Za-z0-9_-]{1,30}$/.test(token.speaker)
          ? `${this.connection}-${token.speaker}`
          : undefined;
      const field =
        token.translation_status === "translation" ? "translation" : "original";
      let target = this.current;
      if (field === "translation" && speaker) {
        // Late translations retain their speaker; don't attach speaker A's words to B.
        target = undefined;
        for (let i = rows.length - 1; i >= this.segmentStart; i--)
          if (rows[i].speaker === speaker) {
            target = i;
            break;
          }
      } else if (
        target !== undefined &&
        (rows[target].speaker !== speaker ||
          (field === "original" && rows[target].original.length > 1500))
      )
        target = undefined;
      if (target === undefined) {
        target = rows.length;
        rows.push({
          id: (this.ids[target] ??= crypto.randomUUID()),
          startMs: this.offset,
          endMs: this.offset,
          original: "",
          translation: "",
          bookmark: false,
          speaker,
        });
      }
      this.current = target;
      const row = rows[target];
      if (field === "original") {
        if (token.language) row.originalLanguage = token.language;
        if (typeof token.start_ms === "number" && !row.original)
          row.startMs = this.offset + Math.max(0, token.start_ms);
        if (typeof token.end_ms === "number")
          row.endMs = Math.max(row.startMs, this.offset + token.end_ms);
      } else {
        if (token.language) row.translationLanguage = token.language;
        if (token.source_language) row.originalLanguage = token.source_language;
      }
      row[field] += token.text;
      row.provisional = Boolean(row.provisional || provisional);
    };
    tokens
      .filter((t) => t.is_final)
      .forEach((t) => append(this.rows, t, false));
    const current = this.current,
      start = this.segmentStart;
    const preview = this.rows.map((r) => ({ ...r }));
    tokens.filter((t) => !t.is_final).forEach((t) => append(preview, t, true));
    this.current = current;
    this.segmentStart = start;
    return preview.filter((r) => r.original.trim() || r.translation.trim());
  }
}

export class Speech {
  private socket?: WebSocket;
  private keepalive?: ReturnType<typeof setInterval>;
  private ended = false;
  private closing?: () => void;
  private warned = false;
  constructor(
    private onRows: (rows: Row[]) => void,
    private onFailure: (message: string, retryable: boolean) => void,
    private offset = 0,
  ) {}
  connect(token: { apiKey: string; websocketUrl: string }, settings: Document) {
    const transcript = new Transcript(this.offset);
    return new Promise<void>((resolve, reject) => {
      const socket = (this.socket = new WebSocket(token.websocketUrl));
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("전사 연결 시간이 초과됐습니다."));
      }, 12000);
      socket.onopen = () => {
        clearTimeout(timer);
        socket.send(
          JSON.stringify({
            api_key: token.apiKey,
            model: "stt-rt-v5",
            audio_format: "pcm_s16le",
            sample_rate: 48000,
            num_channels: 1,
            language_hints: [
              ...new Set([settings.sourceLanguage, settings.targetLanguage]),
            ],
            enable_endpoint_detection: true,
            max_endpoint_delay_ms: 1500,
            enable_language_identification: true,
            enable_speaker_diarization: true,
            ...(settings.domain === "cloud"
              ? {
                  context: {
                    general: [
                      {
                        key: "domain",
                        value:
                          "IT, cloud engineering, Oracle Database, database migration",
                      },
                    ],
                    terms: [
                      "OCI",
                      "Oracle Database",
                      "Data Guard",
                      "RMAN",
                      "RAC",
                      "VCN",
                      "NSG",
                      "Exadata",
                      "migration",
                      "마이그레이션",
                    ],
                  },
                }
              : {}),
            ...(settings.mode === "translate" && settings.translateKorean
              ? {
                  translation: {
                    type: "two_way",
                    language_a: "ko",
                    language_b: settings.sourceLanguage,
                  },
                }
              : settings.mode === "translate" ||
                  settings.sourceLanguage !== "ko"
                ? {
                    translation: {
                      type: "one_way",
                      target_language:
                        settings.mode === "record"
                          ? "ko"
                          : settings.targetLanguage,
                    },
                  }
                : {}),
          }),
        );
        this.keepalive = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN && !this.ended)
            socket.send(JSON.stringify({ type: "keepalive" }));
        }, 5000);
        resolve();
      };
      socket.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data as string) as {
            tokens?: Token[];
            error_code?: number;
            error_type?: string;
            finished?: boolean;
          };
          if (message.error_code) {
            this.fail(
              message.error_code === 401
                ? "Soniox API 키를 확인해 주세요."
                : "전사 연결이 중단됐습니다. 키·잔액·네트워크를 확인해 주세요.",
              retryableSpeechError(message.error_code, message.error_type),
            );
            socket.close();
          }
          if (message.tokens) {
            this.onRows(transcript.ingest(message.tokens));
          }
          if (message.finished) {
            this.ended = true;
            this.closing?.();
            socket.close();
          }
        } catch {
          this.fail("전사 응답을 처리하지 못했습니다.");
          socket.close();
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("전사 서비스에 연결하지 못했습니다."));
        this.fail("전사 서비스 연결이 끊겼습니다.");
      };
      socket.onclose = () => {
        clearTimeout(timer);
        clearInterval(this.keepalive);
        reject(new Error("전사 연결이 종료됐습니다."));
        if (!this.ended)
          this.fail(
            "전사 연결이 끊겼습니다. 중단 구간은 자동으로 전사되지 않습니다.",
          );
        this.closing?.();
      };
    });
  }
  send(data: ArrayBuffer) {
    if (this.socket?.readyState !== WebSocket.OPEN || this.ended) return;
    if (this.socket.bufferedAmount > 48000 * 2 * 5) {
      this.fail("전사 전송이 지연돼 연결을 멈췄습니다.");
      this.socket.close();
      return;
    }
    this.socket.send(data);
  }
  private fail(message: string, retryable = true) {
    if (!this.warned) {
      this.warned = true;
      this.onFailure(message + " 녹음 저장은 계속됩니다.", retryable);
    }
  }
  async finish() {
    clearInterval(this.keepalive);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.ended = true;
      socket?.close();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.fail(
          "마지막 전사 응답이 도착하지 않아 표시된 내용까지만 저장합니다.",
        );
        resolve();
      }, 5000);
      this.closing = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.send("");
    });
    this.ended = true;
    socket.close();
  }
  abort() {
    this.ended = true;
    clearInterval(this.keepalive);
    this.socket?.close();
  }
}
