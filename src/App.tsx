import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { apiRequest, setCsrf } from "./api";
import { Recording, type RecordingView } from "./recording";
import { listDrafts } from "./drafts";
import {
  clock,
  errorText,
  languages,
  meetingPath,
  type Document,
  type Draft,
  type Meeting,
  type Summary,
} from "./model";
type Session = {
  subject: string;
  login: string;
  csrf: string;
  speechReady: boolean;
  sonioxRegion: string;
  aiReady: boolean;
  aiProvider: string;
  aiModel: string;
};
type Job = {
  id: string;
  state: "RUNNING" | "COMPLETED" | "FAILED";
  error?: string;
};
type Detail = Meeting & {
  context: string;
  review: {
    summary?: string;
    minutes?: string;
    onePage?: string;
    correctedRows?: { id: string; text: string }[];
  };
  aiJob?: Job;
};
const base = meetingPath("local");
const stateNames: Record<string, string> = {
  preparing: "시작 중",
  live: "녹음 중",
  paused: "일시 정지",
  saving: "저장 중",
  pending: "확인 필요",
  complete: "저장 완료",
  discarded: "저장 취소",
  failed: "시작 실패",
};
function storedTheme() {
  try {
    return localStorage.getItem("meet-standalone-theme") === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}
export function App() {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState("");
  const [theme, setTheme] = useState(storedTheme);
  const toggleTheme = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("meet-standalone-theme", theme);
    } catch {
      /* Theme is optional. */
    }
  }, [theme]);
  useEffect(() => {
    apiRequest<Session | null>("/api/session")
      .then((s) => {
        setCsrf(s?.csrf || "");
        setSession(s);
      })
      .catch((e) => setError(errorText(e)));
    const key = (e: KeyboardEvent) => {
      if (
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !(e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        ) &&
        e.code === "KeyD"
      ) {
        e.preventDefault();
        toggleTheme();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggleTheme]);
  return (
    <>
      {session ? (
        <Workspace
          session={session}
          onLogout={() => {
            setCsrf("");
            setSession(null);
          }}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      ) : (
        <main className="login-shell">
          <div className="login-card">
            <Brand />
            <h1>회의의 흐름을 기록하세요.</h1>
            <p>설치 시 지정한 계정으로 로그인합니다.</p>
            {session === undefined ? (
              <p role="status">{error || "연결 중…"}</p>
            ) : (
              <Login
                onSession={(s) => {
                  setCsrf(s.csrf);
                  setSession(s);
                }}
              />
            )}
            <button className="quiet" onClick={toggleTheme}>
              {theme === "dark" ? "☀ 라이트" : "☾ 다크"}
            </button>
          </div>
        </main>
      )}
    </>
  );
}
function Brand() {
  return (
    <div className="brand">
      <img src="/icon.png" alt="" />
      <span>
        Meet<small>독립 설치판</small>
      </span>
    </div>
  );
}
function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setPending(true);
    const data = new FormData(e.currentTarget);
    try {
      onSession(
        await apiRequest<Session>("/api/login", "POST", {
          login: data.get("login"),
          password: data.get("password"),
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <label>
        아이디
        <input name="login" autoComplete="username" required />
      </label>
      <label>
        비밀번호
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <button className="primary" disabled={pending}>
        {pending ? "확인 중…" : "로그인"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function Workspace({
  session,
  onLogout,
  theme,
  toggleTheme,
}: {
  session: Session;
  onLogout: () => void;
  theme: string;
  toggleTheme: () => void;
}) {
  const [page, setPage] = useState<"new" | "library" | "settings">("new");
  const [library, setLibrary] = useState<Summary[]>([]),
    [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<Detail>(),
    [view, setView] = useState<RecordingView>();
  const [title, setTitle] = useState(""),
    [settings, setSettings] = useState<Document>({
      mode: "record",
      source: "mic",
      sourceLanguage: "ko",
      targetLanguage: "en",
      transcribe: session.speechReady,
      autoWork: false,
      durationMs: 0,
      rows: [],
      domain: "cloud",
      audioProfile: "natural",
    });
  const [error, setError] = useState("");
  const recorder = useRef<Recording | undefined>(undefined),
    completeId = useRef(""),
    bottom = useRef<HTMLDivElement>(null);
  const busy = Boolean(
    view &&
      ["preparing", "live", "paused", "saving", "pending"].includes(view.state),
  );
  const refresh = useCallback(async () => {
    const [meetings, pending] = await Promise.all([
      apiRequest<Summary[]>(base),
      listDrafts(session.subject, "local"),
    ]);
    setLibrary(meetings);
    setDrafts(pending);
  }, [session.subject]);
  useEffect(() => {
    void refresh().catch((e) => setError(errorText(e)));
  }, [refresh]);
  useEffect(() => {
    const visibility = () => {
      void recorder.current?.visibilityChanged();
    };
    const before = (e: BeforeUnloadEvent) => {
      if (busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("beforeunload", before);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("beforeunload", before);
    };
  }, [busy]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [view?.meeting?.document.rows]);
  useEffect(() => {
    if (
      view?.state === "complete" &&
      view.meeting &&
      completeId.current !== view.meeting.id
    ) {
      completeId.current = view.meeting.id;
      const meeting = view.meeting;
      void (async () => {
        const detail = await apiRequest<Detail>(`${base}/${meeting.id}`);
        if (
          session.aiReady &&
          detail.document.rows.some((r) => !r.provisional) &&
          !detail.review?.summary
        ) {
          try {
            await apiRequest(`${base}/${meeting.id}/ai`, "POST", {
              task: "summary",
            });
          } catch (e) {
            setError(errorText(e));
          }
        }
        setSelected(await apiRequest<Detail>(`${base}/${meeting.id}`));
        setPage("library");
        await refresh();
      })().catch((e) => setError(errorText(e)));
    }
    if (view?.state === "discarded") {
      void refresh().catch((e) => setError(errorText(e)));
    }
  }, [view?.state, view?.meeting?.id, refresh, session.aiReady]);
  async function start(draft?: Draft) {
    setError("");
    setSelected(undefined);
    completeId.current = "";
    const instance = new Recording(session.subject, "local", setView);
    recorder.current = instance;
    setView({
      state: "preparing",
      level: 0,
      notice: "",
      pending: 0,
      speechLost: false,
    });
    setPage("new");
    if (draft) await instance.recover(draft);
    else
      await instance.start(
        title.trim() || new Date().toLocaleString("ko-KR") + " 회의",
        { ...settings, rows: [], durationMs: 0 },
      );
  }
  async function open(id: string) {
    try {
      setSelected(await apiRequest<Detail>(`${base}/${id}`));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  const patch = (value: Partial<Document>) =>
    setSettings((s) => ({ ...s, ...value }));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Meet 메뉴">
          <button
            disabled={busy}
            className={page === "new" ? "active" : ""}
            onClick={() => {
              setPage("new");
              setSelected(undefined);
            }}
          >
            ＋ 새 녹음 · 번역
          </button>
          <button
            disabled={busy}
            className={page === "library" ? "active" : ""}
            onClick={() => {
              setPage("library");
              void refresh().catch((e) => setError(errorText(e)));
            }}
          >
            ▤ 나의 기록 <small>{library.length}</small>
          </button>
          <button
            disabled={busy}
            className={page === "settings" ? "active" : ""}
            onClick={() => setPage("settings")}
          >
            ⚙ 연결 설정
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span>{session.login}</span>
          <button onClick={toggleTheme} aria-label="테마 전환">
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void apiRequest("/api/logout", "POST")
                .then(onLogout)
                .catch((e) => setError(errorText(e)));
            }}
          >
            로그아웃
          </button>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">CLOUDRAGON MEET</p>
            <h1>
              {page === "new"
                ? "새 녹음 · 번역"
                : page === "library"
                  ? "나의 기록"
                  : "연결 설정"}
            </h1>
          </div>
          <span className="pill">
            {busy ? stateNames[view!.state] : "독립 공간"}
          </span>
        </header>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {page === "settings" ? (
          <section className="card settings">
            <h2>이 서버의 연결</h2>
            <dl>
              <dt>전사 · 번역 · 음성 출력</dt>
              <dd>
                {session.speechReady
                  ? `Soniox 연결 설정됨 · ${session.sonioxRegion}`
                  : "미설정 · 녹음만 사용 가능"}
              </dd>
              <dt>AI 회의록</dt>
              <dd>
                {session.aiReady
                  ? `${session.aiProvider} · ${session.aiModel}`
                  : "미설정 · 수동 회의록 사용 가능"}
              </dd>
            </dl>
            <p>
              서버 폴더에서 <code>npm run setup</code>을 실행하거나{" "}
              <code>.env</code>를 수정한 뒤 서버를 재시작하세요. 키는 이 화면에
              표시하지 않습니다.
            </p>
            <p>
              API 사용료는 설정한 계정에 청구됩니다. 웹 녹음은 휴대폰 화면을
              잠그면 중단될 수 있습니다.
            </p>
          </section>
        ) : page === "new" ? (
          <>
            <section className="card">
              <div className="section-heading">
                <h2>회의 준비</h2>
                <span>최대 9시간</span>
              </div>
              <fieldset disabled={busy}>
                <label>
                  회의 제목
                  <input
                    placeholder="어떤 대화를 기록할까요?"
                    value={title}
                    maxLength={200}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <div className="form-grid">
                  <label>
                    사용 방식
                    <select
                      value={settings.mode}
                      onChange={(e) =>
                        patch({ mode: e.target.value as Document["mode"] })
                      }
                    >
                      <option value="record">녹음 · 전사</option>
                      <option value="translate">실시간 번역</option>
                    </select>
                  </label>
                  <label>
                    오디오 입력
                    <select
                      value={settings.source}
                      onChange={(e) =>
                        patch({ source: e.target.value as Document["source"] })
                      }
                    >
                      <option value="mic">마이크</option>
                      <option value="shared">PC 탭 · 화면 오디오</option>
                      <option value="both">마이크 + 공유 소리</option>
                    </select>
                  </label>
                  <label>
                    {settings.translateKorean ? "대화 상대 언어" : "발화 언어"}
                    <select
                      value={settings.sourceLanguage}
                      onChange={(e) =>
                        patch({ sourceLanguage: e.target.value })
                      }
                    >
                      {languages.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    번역 언어
                    <select
                      disabled={settings.translateKorean}
                      value={settings.targetLanguage}
                      onChange={(e) =>
                        patch({ targetLanguage: e.target.value })
                      }
                    >
                      {languages.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="checks">
                  <label>
                    <input
                      type="checkbox"
                      disabled={!session.speechReady}
                      checked={settings.transcribe}
                      onChange={(e) => patch({ transcribe: e.target.checked })}
                    />{" "}
                    실시간 전사
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.domain === "cloud"}
                      onChange={(e) =>
                        patch({
                          domain: e.target.checked ? "cloud" : "general",
                        })
                      }
                    />{" "}
                    IT · 클라우드 용어
                  </label>
                  {settings.mode === "translate" && (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(settings.translateKorean)}
                          onChange={(e) =>
                            patch({
                              translateKorean: e.target.checked,
                              sourceLanguage:
                                settings.sourceLanguage === "ko"
                                  ? "en"
                                  : settings.sourceLanguage,
                              targetLanguage: "ko",
                              speakTranslation: false,
                            })
                          }
                        />{" "}
                        내 한국어도 상대 언어로 번역
                      </label>
                      {settings.translateKorean && (
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(settings.speakTranslation)}
                            onChange={(e) =>
                              patch({ speakTranslation: e.target.checked })
                            }
                          />{" "}
                          선택한 번역을 음성으로 재생
                        </label>
                      )}
                    </>
                  )}
                </div>
              </fieldset>
              {!busy && (
                <button
                  className="primary record-start"
                  disabled={
                    settings.mode === "translate" && !session.speechReady
                  }
                  onClick={() => void start()}
                >
                  ● 녹음 시작
                </button>
              )}
              {busy && (
                <div className="record-controls">
                  <strong className="clock">
                    {clock(view?.meeting?.document.durationMs || 0)}
                  </strong>
                  <span className="pill live">{stateNames[view!.state]}</span>
                  {["live", "paused"].includes(view!.state) && (
                    <>
                      <button
                        onClick={() =>
                          void (view!.state === "paused"
                            ? recorder.current?.resume()
                            : recorder.current?.pause())
                        }
                      >
                        {view!.state === "paused" ? "다시 시작" : "일시 정지"}
                      </button>
                      <button
                        className="primary"
                        onClick={() => void recorder.current?.finish()}
                      >
                        종료 · 저장
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          if (
                            confirm(
                              "음성과 전사를 모두 저장하지 않고 종료할까요?",
                            )
                          )
                            void recorder.current?.discard();
                        }}
                      >
                        저장하지 않고 종료
                      </button>
                    </>
                  )}
                  {view!.state === "pending" && (
                    <button
                      onClick={() =>
                        void (view!.discardRequested
                          ? recorder.current?.discard()
                          : recorder.current?.finish())
                      }
                    >
                      {view!.discardRequested
                        ? "삭제 다시 시도"
                        : "저장 다시 시도"}
                    </button>
                  )}
                </div>
              )}
              {view?.notice && (
                <p className="notice" role="status">
                  {view.notice}
                </p>
              )}
              {view?.inputWarning && <p role="alert">{view.inputWarning}</p>}
              {view?.backgroundRisk && (
                <p className="notice">
                  화면이 꺼진 동안 녹음이나 전사가 중단됐을 수 있습니다. 원음을
                  확인하세요.
                </p>
              )}
              {view?.playbackBlocked && (
                <button onClick={() => recorder.current?.enablePlayback()}>
                  음성 재생 허용
                </button>
              )}
            </section>
            <section className="card">
              <div className="section-heading">
                <h2>실시간 전사</h2>
                <span>{view?.meeting?.document.rows.length || 0}개 발언</span>
              </div>
              <div className="transcript live-transcript" aria-live="polite">
                {!view?.meeting?.document.rows.length && (
                  <p className="empty">대화를 시작하면 여기에 표시됩니다.</p>
                )}
                {view?.meeting?.document.rows.map((r) => (
                  <article
                    key={r.id}
                    className={r.provisional ? "provisional" : ""}
                  >
                    <small>
                      {clock(r.startMs)}{" "}
                      {r.speaker ? `· 화자 ${r.speaker.split("-").at(-1)}` : ""}
                    </small>
                    <p>{r.original}</p>
                    {r.translation && (
                      <p className="translation">{r.translation}</p>
                    )}
                    {settings.speakTranslation &&
                      !r.provisional &&
                      r.originalLanguage === "ko" && (
                        <button
                          onClick={() =>
                            recorder.current?.playTranslation(r.id)
                          }
                        >
                          ▶ 번역 재생
                        </button>
                      )}
                  </article>
                ))}
                <div ref={bottom} />
              </div>
            </section>
            {!busy && drafts.length > 0 && (
              <section className="card">
                <h2>기기에 남은 기록</h2>
                {drafts.map((d) => (
                  <div className="recovery" key={d.key}>
                    <span>{d.meeting.title}</span>
                    <button onClick={() => void start(d)}>
                      {d.discardRequested ? "삭제 이어서 하기" : "저장 복구"}
                    </button>
                  </div>
                ))}
              </section>
            )}
          </>
        ) : (
          <div className="library-grid">
            <section className="card library-list">
              <h2>회의 기록</h2>
              {!library.length && (
                <p className="empty">아직 저장된 회의가 없습니다.</p>
              )}
              {library.map((m) => (
                <button
                  className={selected?.id === m.id ? "chosen" : ""}
                  key={m.id}
                  onClick={() => void open(m.id)}
                >
                  <strong>{m.title}</strong>
                  <small>
                    {new Date(m.createdAt).toLocaleString("ko-KR")} ·{" "}
                    {m.state === "COMPLETED" ? "완료" : "미완료"}
                  </small>
                </button>
              ))}
            </section>
            {selected ? (
              <MeetingDetail
                key={selected.id}
                meeting={selected}
                aiReady={session.aiReady}
                onChange={setSelected}
                onDelete={() => {
                  setSelected(undefined);
                  void refresh().catch((e) => setError(errorText(e)));
                }}
              />
            ) : (
              <section className="card empty">회의를 선택해 주세요.</section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
function MeetingDetail({
  meeting,
  aiReady,
  onChange,
  onDelete,
}: {
  meeting: Detail;
  aiReady: boolean;
  onChange: (meeting: Detail) => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<
    "original" | "corrected" | "minutes" | "onePage"
  >("minutes");
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [edit, setEdit] = useState({
    title: meeting.title,
    summary: meeting.review?.summary || "",
    minutes: meeting.review?.minutes || "",
    onePage: meeting.review?.onePage || "",
  });
  const [context, setContext] = useState(meeting.context || "");
  const running = meeting.aiJob?.state === "RUNNING";
  useEffect(() => {
    setEdit({
      title: meeting.title,
      summary: meeting.review?.summary || "",
      minutes: meeting.review?.minutes || "",
      onePage: meeting.review?.onePage || "",
    });
    setContext(meeting.context || "");
  }, [meeting]);
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const m = await apiRequest<Detail>(`${base}/${meeting.id}`);
        if (cancelled) return;
        onChange(m);
        if (m.aiJob?.state === "RUNNING") timer = setTimeout(poll, 1500);
      } catch (e) {
        if (!cancelled) {
          setError(errorText(e));
          timer = setTimeout(poll, 5000);
        }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [running, meeting.id, onChange]);
  async function perform(action: () => Promise<void>) {
    setError("");
    setPending(true);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  async function ai(task: "summary" | "correct") {
    await apiRequest(`${base}/${meeting.id}/ai`, "POST", { task });
    onChange(await apiRequest<Detail>(`${base}/${meeting.id}`));
  }
  return (
    <section className="card detail">
      <div className="section-heading">
        <h2>{meeting.title}</h2>
        <button
          className="danger"
          disabled={pending || running}
          onClick={() => {
            if (confirm("이 회의의 음성과 전사, 회의록을 삭제할까요?"))
              void perform(async () => {
                await apiRequest(`${base}/${meeting.id}`, "DELETE");
                onDelete();
              });
          }}
        >
          삭제
        </button>
      </div>
      <p className="meta">
        {clock(meeting.document.durationMs)} · {meeting.document.rows.length}개
        발언
      </p>
      {meeting.chunks.length > 0 && (
        <audio controls preload="none" src={`${base}/${meeting.id}/audio`} />
      )}
      {meeting.document.transcriptIncomplete && (
        <p className="notice">
          전사가 일부 누락됐을 수 있습니다. 원음을 확인하세요.
        </p>
      )}
      <details>
        <summary>회의 배경 · 고객 · 프로젝트 맥락</summary>
        <label>
          AI가 참고할 맥락
          <textarea
            maxLength={8000}
            disabled={pending || running}
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </label>
        <button
          disabled={pending || running}
          onClick={() =>
            void perform(async () =>
              onChange(
                await apiRequest<Detail>(
                  `${base}/${meeting.id}/context`,
                  "PUT",
                  { revision: meeting.revision, context },
                ),
              ),
            )
          }
        >
          배경 저장
        </button>
      </details>
      <div className="actions">
        <button
          disabled={
            !aiReady || pending || running || meeting.state !== "COMPLETED"
          }
          onClick={() => void perform(() => ai("summary"))}
        >
          ✦ AI 회의록 생성
        </button>
        <button
          disabled={
            !aiReady || pending || running || meeting.state !== "COMPLETED"
          }
          onClick={() => void perform(() => ai("correct"))}
        >
          ✦ AI 전사 교정
        </button>
      </div>
      {running && (
        <p role="status" className="notice">
          AI가 처리 중입니다. 완료하면 자동으로 표시됩니다.
        </p>
      )}
      {meeting.aiJob?.state === "FAILED" && (
        <p role="alert" className="notice error">
          {meeting.aiJob.error}
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="tabs" role="tablist" aria-label="회의 보기">
        {(
          [
            ["minutes", "회의록 · 편집"],
            ["onePage", "한 장 요약"],
            ["original", "원문"],
            ["corrected", "AI 교정본"],
          ] as const
        ).map(([key, label]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "selected" : ""}
            key={key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "minutes" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () =>
              onChange(
                await apiRequest<Detail>(
                  `${base}/${meeting.id}/review`,
                  "PUT",
                  { revision: meeting.revision, ...edit },
                ),
              ),
            );
          }}
        >
          <fieldset disabled={pending || running}>
            <label>
              제목
              <input
                maxLength={200}
                value={edit.title}
                onChange={(e) =>
                  setEdit((v) => ({ ...v, title: e.target.value }))
                }
              />
            </label>
            <label>
              핵심 요약
              <textarea
                maxLength={25000}
                value={edit.summary}
                onChange={(e) =>
                  setEdit((v) => ({ ...v, summary: e.target.value }))
                }
              />
            </label>
            <label>
              주요 발언 · 결정 · 다음 할 일
              <textarea
                className="minutes-editor"
                maxLength={25000}
                value={edit.minutes}
                onChange={(e) =>
                  setEdit((v) => ({ ...v, minutes: e.target.value }))
                }
              />
            </label>
            <label>
              한 장 요약
              <textarea
                maxLength={25000}
                value={edit.onePage}
                onChange={(e) =>
                  setEdit((v) => ({ ...v, onePage: e.target.value }))
                }
              />
            </label>
            <button
              className="primary"
              disabled={pending || running || meeting.state !== "COMPLETED"}
            >
              회의록 저장
            </button>
          </fieldset>
        </form>
      ) : tab === "onePage" ? (
        <div className="one-page">
          <span className="eyebrow">MEETING BRIEF</span>
          <h2>{meeting.title}</h2>
          <p>
            {meeting.review?.summary ||
              "회의록을 작성하거나 AI로 생성해 주세요."}
          </p>
          <div className="one-page-body">{meeting.review?.onePage}</div>
          <button onClick={() => window.print()}>인쇄 · PDF 저장</button>
        </div>
      ) : (
        <div className="transcript">
          {tab === "corrected" && !meeting.review?.correctedRows && (
            <p className="empty">
              AI 전사 교정 버튼을 눌러 생성하세요. 원문은 보존됩니다.
            </p>
          )}
          {meeting.document.rows.map((r) => (
            <article key={r.id}>
              <small>{clock(r.startMs)}</small>
              <p>
                {tab === "original"
                  ? r.original
                  : meeting.review?.correctedRows?.find((c) => c.id === r.id)
                      ?.text || r.original}
              </p>
              {tab === "original" && r.translation && (
                <p className="translation">{r.translation}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
