export type Mode = "record" | "translate";
export type Source = "mic" | "shared" | "both";
export type Row = {
  id: string;
  startMs: number;
  endMs: number;
  original: string;
  translation: string;
  originalLanguage?: string;
  translationLanguage?: string;
  bookmark: boolean;
  speaker?: string;
  provisional?: boolean;
};
export type Document = {
  mode: Mode;
  source: Source;
  sourceLanguage: string;
  targetLanguage: string;
  translateKorean?: boolean;
  speakTranslation?: boolean;
  transcribe: boolean;
  autoWork: boolean;
  durationMs: number;
  rows: Row[];
  transcriptIncomplete?: boolean;
  domain?: "cloud" | "general";
  audioProfile?: "natural" | "voice";
  audioDiagnostics?: AudioDiagnostics;
};
export type AudioDiagnostics = {
  path: "direct" | "mixed";
  requestedBitrate: number;
  actualBitrate?: number;
  sampleRate: number;
  channels?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};
export type Chunk = { sequence: number; bytes: number; hash: string };
export type Meeting = {
  id: string;
  title: string;
  state: "RECORDING" | "COMPLETED";
  revision: number;
  mimeType: string;
  createdAt: string;
  document: Document;
  chunks: Chunk[];
};
export type Summary = Pick<Meeting, "id" | "title" | "state" | "createdAt">;
export type Configuration = {
  storageReady: boolean;
  speech: { hasKey: boolean; keyStorageReady: boolean; region: string };
  tts?: { provider: "soniox"; model: string };
};
export type Draft = {
  key: string;
  subject: string;
  workspace: string;
  meeting: Meeting;
  nextSequence: number;
  stopped: boolean;
  discardRequested?: boolean;
};
export const languages = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "vi", label: "Tiếng Việt" },
];
export const clock = (ms: number) =>
  [
    Math.floor(ms / 3600000),
    Math.floor(ms / 60000) % 60,
    Math.floor(ms / 1000) % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
export const meetingPath = (workspace: string, id?: string) =>
  `/api/workspaces/${encodeURIComponent(workspace)}/meetings${id ? "/" + encodeURIComponent(id) : ""}`;
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "작업을 마치지 못했습니다. 다시 시도해 주세요.";
export function downloadText(
  title: string,
  contents: string,
  type = "text/markdown;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = title;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function exportMeeting(meeting: Meeting) {
  return (
    `# ${meeting.title}\n\n${meeting.createdAt}\n\n` +
    meeting.document.rows
      .map(
        (r) =>
          `## ${clock(r.startMs)}${r.bookmark ? " ★" : ""}\n\n${r.original}\n\n${r.translation ? r.translation + "\n\n" : ""}`,
      )
      .join("")
  );
}
