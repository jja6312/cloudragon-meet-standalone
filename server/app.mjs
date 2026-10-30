import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { openStore } from "./store.mjs";
import { verifyPassword } from "./config.mjs";
import { ApiError, providers } from "./providers.mjs";
const idPattern = /^[a-f0-9-]{36}$/;
const languages = new Set(["ko", "en", "ja", "zh", "es", "fr", "de", "vi"]);
const invalid = () => {
  throw new ApiError(400, "입력값을 확인해 주세요.");
};
const text = (value, limit, required = false) => {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (required && !value.trim())
  )
    invalid();
  return value;
};
function documentValue(value) {
  if (
    !value ||
    !["record", "translate"].includes(value.mode) ||
    !["mic", "shared", "both"].includes(value.source) ||
    !languages.has(value.sourceLanguage) ||
    !languages.has(value.targetLanguage) ||
    !Number.isInteger(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > 9 * 3600_000 + 10_000 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 10_000
  )
    invalid();
  const ids = new Set();
  const rows = value.rows.map((row) => {
    if (
      !row ||
      typeof row.id !== "string" ||
      !idPattern.test(row.id) ||
      ids.has(row.id) ||
      !Number.isFinite(row.startMs) ||
      !Number.isFinite(row.endMs) ||
      row.startMs < 0 ||
      row.endMs < row.startMs
    )
      invalid();
    ids.add(row.id);
    return {
      id: row.id,
      startMs: row.startMs,
      endMs: row.endMs,
      original: text(row.original, 8000),
      translation: text(row.translation, 8000),
      bookmark: row.bookmark === true,
      speaker: row.speaker === undefined ? undefined : text(row.speaker, 100),
      originalLanguage: languages.has(row.originalLanguage)
        ? row.originalLanguage
        : undefined,
      translationLanguage: languages.has(row.translationLanguage)
        ? row.translationLanguage
        : undefined,
      provisional: row.provisional === true,
    };
  });
  return {
    mode: value.mode,
    source: value.source,
    sourceLanguage: value.sourceLanguage,
    targetLanguage: value.targetLanguage,
    translateKorean: value.translateKorean === true,
    speakTranslation: value.speakTranslation === true,
    transcribe: value.transcribe === true,
    autoWork: false,
    durationMs: value.durationMs,
    rows,
    transcriptIncomplete: value.transcriptIncomplete === true,
    domain: value.domain === "cloud" ? "cloud" : "general",
    audioProfile: value.audioProfile === "voice" ? "voice" : "natural",
  };
}
async function body(req, limit = 2_500_000, binary = false) {
  if (
    !(req.headers["content-type"] || "").startsWith(
      binary ? "application/octet-stream" : "application/json",
    )
  )
    throw new ApiError(415, "요청 형식을 확인해 주세요.");
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new ApiError(413, "요청이 너무 큽니다.");
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  if (binary) return bytes;
  try {
    return JSON.parse(bytes);
  } catch {
    throw new ApiError(400, "올바른 JSON이 아닙니다.");
  }
}
function send(res, status, value) {
  res.statusCode = status;
  if (value === undefined) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}
export function createApp(config, { transport } = {}) {
  const store = openStore(config.dataDir),
    db = store.db,
    provider = providers(config, transport);
  const attempts = new Map();
  let checkingPasswords = 0;
  const sessionHash = (token) =>
    createHmac("sha256", config.secret).update(token).digest("hex");
  const cookieName = config.baseUrl.startsWith("https:")
    ? "__Host-meet"
    : "meet-local";
  const cookie = (token, seconds) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${config.baseUrl.startsWith("https:") ? "; Secure" : ""}`;
  function session(req) {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return db
      .prepare("SELECT * FROM sessions WHERE id=? AND expires>?")
      .get(sessionHash(token), Date.now());
  }
  function reserve(kind, max) {
    if (!store.reserve(kind, max))
      throw new ApiError(429, "오늘의 제공자 사용 한도에 도달했습니다.");
  }
  const publicConfig = () => ({
    speechReady: Boolean(config.sonioxKey),
    sonioxRegion: config.sonioxRegion,
    aiReady: config.aiProvider !== "none",
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
  });
  async function audio(req, res, meeting) {
    const total = meeting.chunks.reduce((sum, c) => sum + c.bytes, 0);
    if (!total) throw new ApiError(404, "저장된 음성이 없습니다.");
    let start = 0,
      end = total - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res.setHeader("Content-Range", `bytes */${total}`);
        return send(res, 416);
      }
      if (!match[1]) start = Math.max(0, total - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= total
      ) {
        res.setHeader("Content-Range", `bytes */${total}`);
        return send(res, 416);
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    }
    res.setHeader("Content-Type", meeting.mimeType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    let offset = 0;
    for (const row of db
      .prepare(
        "SELECT data,bytes FROM chunks WHERE meeting_id=? ORDER BY sequence",
      )
      .iterate(meeting.id)) {
      if (offset > end || res.destroyed) break;
      if (offset + row.bytes > start) {
        const bytes = Buffer.from(row.data).subarray(
          Math.max(0, start - offset),
          Math.min(row.bytes, end - offset + 1),
        );
        if (!res.write(bytes)) await once(res, "drain");
      }
      offset += row.bytes;
    }
    res.end();
  }
  async function job(meeting, task, id) {
    try {
      const result = await provider.ai(task, meeting);
      const current = store.get(meeting.id);
      if (!current) return; // Deleted while the provider was running: never resurrect it.
      if (current.revision !== meeting.revision)
        throw new ApiError(
          409,
          "회의가 수정됐습니다. 현재 판본에서 다시 생성해 주세요.",
        );
      current.review = {
        ...current.review,
        ...(task === "summary" ? result : { correctedRows: result.rows }),
      };
      current.revision++;
      store.save(current);
      db.prepare("UPDATE jobs SET state='COMPLETED' WHERE id=?").run(id);
    } catch (error) {
      db.prepare("UPDATE jobs SET state='FAILED',error=? WHERE id=?").run(
        error instanceof ApiError
          ? error.message
          : "AI 처리를 마치지 못했습니다.",
        id,
      );
    }
  }
  const pendingJobs = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' wss://stt-rt.soniox.com wss://stt-rt.eu.soniox.com wss://stt-rt.jp.soniox.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (config.baseUrl.startsWith("https:"))
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const url = new URL(req.url, config.baseUrl),
        p = url.pathname;
      if (req.headers.host !== new URL(config.baseUrl).host)
        throw new ApiError(403, "접속 주소를 확인해 주세요.");
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new ApiError(403, "다른 사이트의 요청은 허용하지 않습니다.");
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers.origin !== config.baseUrl
      )
        throw new ApiError(403, "요청 출처를 확인해 주세요.");
      if (p === "/api/health" && req.method === "GET")
        return send(res, 200, { status: "ok" });
      if (p === "/api/login" && req.method === "POST") {
        const key = req.socket.remoteAddress || "unknown",
          now = Date.now();
        for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
        const meter = attempts.get(key) || { count: 0, until: now + 60_000 };
        if (
          ++meter.count > 10 ||
          attempts.size > 1000 ||
          checkingPasswords >= 3
        )
          throw new ApiError(429, "잠시 후 다시 로그인해 주세요.");
        attempts.set(key, meter);
        const b = await body(req, 4096);
        if (typeof b.password !== "string" || b.password.length > 1024)
          invalid();
        checkingPasswords++;
        let valid;
        try {
          valid = await verifyPassword(b.password, config.passwordHash);
        } finally {
          checkingPasswords--;
        }
        if (b.login !== config.login || !valid)
          throw new ApiError(401, "아이디 또는 비밀번호를 확인해 주세요.");
        const token = randomBytes(32).toString("hex"),
          csrf = randomBytes(32).toString("hex");
        db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
        db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
          sessionHash(token),
          csrf,
          now + 12 * 3600_000,
        );
        res.setHeader("Set-Cookie", cookie(token, 12 * 3600));
        return send(res, 200, {
          csrf,
          subject: sessionHash(config.login).slice(0, 32),
          login: config.login,
          ...publicConfig(),
        });
      }
      const user = session(req);
      if (p === "/api/session" && req.method === "GET")
        return send(
          res,
          200,
          user
            ? {
                csrf: user.csrf,
                subject: sessionHash(config.login).slice(0, 32),
                login: config.login,
                ...publicConfig(),
              }
            : null,
        );
      if (p.startsWith("/api/")) {
        if (!user) throw new ApiError(401, "로그인이 필요합니다.");
        if (
          !["GET", "HEAD"].includes(req.method) &&
          req.headers["x-csrf-token"] !== user.csrf
        )
          throw new ApiError(403, "로그인을 새로 확인해 주세요.");
        if (p === "/api/logout" && req.method === "POST") {
          db.prepare("DELETE FROM sessions WHERE id=?").run(user.id);
          res.setHeader("Set-Cookie", cookie("", 0));
          return send(res, 204);
        }
        const j = /^\/api\/jobs\/([a-f0-9-]{36})$/.exec(p);
        if (j && req.method === "GET") {
          const value = db
            .prepare("SELECT id,state,error FROM jobs WHERE id=?")
            .get(j[1]);
          if (!value) throw new ApiError(404, "AI 작업이 없습니다.");
          return send(res, 200, value);
        }
        const match =
          /^\/api\/workspaces\/local\/meetings(?:\/([a-f0-9-]{36})(?:\/(complete|discard|audio|speech-token|synthesize|review|ai|context|chunks\/(\d+)))?)?$/.exec(
            p,
          );
        if (!match) throw new ApiError(404, "지원하지 않는 API입니다.");
        const [, id, action, seq] = match;
        if (!id && req.method === "GET") {
          return send(
            res,
            200,
            db
              .prepare(
                "SELECT body FROM meetings ORDER BY rowid DESC LIMIT 1000",
              )
              .all()
              .map((r) => {
                const m = JSON.parse(r.body);
                return {
                  id: m.id,
                  title: m.title,
                  state: m.state,
                  createdAt: m.createdAt,
                };
              }),
          );
        }
        if (!id && req.method === "POST") {
          const b = await body(req);
          if (
            !idPattern.test(b.id || "") ||
            !/^(audio\/(webm|mp4|ogg)(;codecs=[a-zA-Z0-9.,-]+)?)$/.test(
              b.mimeType || "",
            )
          )
            invalid();
          if (store.get(b.id))
            throw new ApiError(409, "이미 존재하는 회의입니다.");
          if (
            db.prepare("SELECT count(*) AS n FROM meetings").get().n >= 10_000
          )
            throw new ApiError(413, "회의 보관 한도에 도달했습니다.");
          const m = {
            id: b.id,
            title: text(b.title, 200, true),
            mimeType: b.mimeType,
            revision: 0,
            state: "RECORDING",
            createdAt: new Date().toISOString(),
            document: documentValue(b.document),
            context: "",
            review: {},
            chunks: [],
          };
          store.save(m);
          return send(res, 201, m);
        }
        if (!id) throw new ApiError(405, "지원하지 않는 동작입니다.");
        const m = store.get(id);
        if (!m && action === "discard" && req.method === "POST")
          return send(res, 204);
        if (!m) throw new ApiError(404, "회의를 찾지 못했습니다.");
        if (!action && req.method === "GET") return send(res, 200, m);
        if (!action && req.method === "DELETE") {
          store.remove(id);
          return send(res, 204);
        }
        if (action === "audio" && req.method === "GET")
          return await audio(req, res, m);
        if (action === "discard" && req.method === "POST") {
          if (m.state !== "RECORDING")
            throw new ApiError(
              409,
              "완료된 기록은 나의 기록에서 삭제해 주세요.",
            );
          store.remove(id);
          return send(res, 204);
        }
        if (action === "speech-token" && req.method === "POST") {
          if (m.state !== "RECORDING")
            throw new ApiError(409, "녹음이 종료됐습니다.");
          reserve("speech", 200);
          return send(res, 200, await provider.token(id));
        }
        if (action === "synthesize" && req.method === "POST") {
          const b = await body(req, 4096),
            d = m.document,
            phrase = text(b.text, 500, true);
          if (
            !d.speakTranslation ||
            !d.translateKorean ||
            d.mode !== "translate" ||
            d.sourceLanguage === "ko"
          )
            invalid();
          reserve("tts", 300);
          const bytes = await provider.synthesize(phrase, d.sourceLanguage);
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("X-Speech-Provider", "soniox");
          return res.end(bytes);
        }
        if (action?.startsWith("chunks/") && req.method === "PUT") {
          if (m.state !== "RECORDING")
            throw new ApiError(409, "녹음이 종료됐습니다.");
          const sequence = Number(seq);
          if (!Number.isInteger(sequence) || sequence < 0 || sequence > 20_000)
            invalid();
          const bytes = await body(req, 2 * 1024 * 1024, true);
          // Body awaits: always re-read state before mutating.
          if (store.get(id)?.state !== "RECORDING")
            throw new ApiError(409, "녹음 상태가 변경됐습니다.");
          const hash = createHash("sha256").update(bytes).digest("hex");
          const previous = db
            .prepare(
              "SELECT hash FROM chunks WHERE meeting_id=? AND sequence=?",
            )
            .get(id, sequence);
          if (previous) {
            if (previous.hash !== hash)
              throw new ApiError(409, "녹음 조각이 일치하지 않습니다.");
            return send(res, 204);
          }
          if (
            !bytes.length ||
            db.prepare("SELECT COALESCE(sum(bytes),0) AS n FROM chunks").get()
              .n +
              bytes.length >
              10 * 1024 ** 3
          )
            throw new ApiError(413, "음성 저장 한도(10GB)에 도달했습니다.");
          db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?)").run(
            id,
            sequence,
            bytes.length,
            hash,
            bytes,
          );
          return send(res, 204);
        }
        if (!action && req.method === "PUT") {
          const b = await body(req),
            current = store.get(id);
          if (
            !current ||
            current.state !== "RECORDING" ||
            b.revision !== current.revision
          )
            throw new ApiError(409, "저장 판본이 변경됐습니다.");
          current.title = text(b.title, 200, true);
          current.document = documentValue(b.document);
          current.revision++;
          store.save(current);
          return send(res, 200, current);
        }
        if (action === "complete" && req.method === "POST") {
          const b = await body(req, 4096),
            current = store.get(id);
          if (!current) throw new ApiError(404, "회의가 없습니다.");
          if (current.state === "COMPLETED") return send(res, 200, current);
          if (
            current.revision !== b.revision ||
            !Number.isInteger(b.chunks) ||
            b.chunks !== current.chunks.length ||
            current.chunks.some((c, i) => c.sequence !== i)
          )
            throw new ApiError(409, "아직 저장되지 않은 녹음 조각이 있습니다.");
          current.state = "COMPLETED";
          current.revision++;
          store.save(current);
          return send(res, 200, current);
        }
        if (action === "context" && req.method === "PUT") {
          const b = await body(req, 25_000),
            current = store.get(id);
          if (!current || current.revision !== b.revision)
            throw new ApiError(409, "저장 판본이 변경됐습니다.");
          current.context = text(b.context, 8000);
          current.revision++;
          store.save(current);
          return send(res, 200, current);
        }
        if (action === "review" && req.method === "PUT") {
          const b = await body(req, 160_000),
            current = store.get(id);
          if (
            !current ||
            current.state !== "COMPLETED" ||
            current.revision !== b.revision
          )
            throw new ApiError(409, "저장 판본이 변경됐습니다.");
          current.title = text(b.title, 200, true);
          current.review = {
            ...current.review,
            summary: text(b.summary, 25_000),
            minutes: text(b.minutes, 25_000),
            onePage: text(b.onePage, 25_000),
          };
          current.revision++;
          store.save(current);
          return send(res, 200, current);
        }
        if (action === "ai" && req.method === "POST") {
          const b = await body(req, 4096),
            current = store.get(id);
          if (
            !current ||
            current.state !== "COMPLETED" ||
            !["summary", "correct"].includes(b.task)
          )
            invalid();
          if (
            db
              .prepare(
                "SELECT id FROM jobs WHERE meeting_id=? AND state='RUNNING'",
              )
              .get(id)
          )
            throw new ApiError(
              409,
              "현재 AI 작업을 완료한 뒤 다시 시도해 주세요.",
            );
          reserve("ai", 30);
          const jobId = crypto.randomUUID();
          db.prepare("INSERT INTO jobs VALUES(?,?,?,'RUNNING',NULL,?)").run(
            jobId,
            id,
            b.task,
            Date.now(),
          );
          const work = job(current, b.task, jobId);
          pendingJobs.add(work);
          void work.finally(() => pendingJobs.delete(work));
          return send(res, 202, { id: jobId, state: "RUNNING" });
        }
        throw new ApiError(405, "지원하지 않는 동작입니다.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new ApiError(405, "지원하지 않는 동작입니다.");
      if (
        ![
          "/",
          "/index.html",
          "/icon.png",
          "/pcm-worklet.js",
          "/PretendardVariable.woff2",
        ].includes(p) &&
        !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(p)
      )
        throw new ApiError(404, "파일이 없습니다.");
      const file = path.join(config.distDir, p === "/" ? "index.html" : p);
      try {
        if (!(await stat(file)).isFile()) throw new Error();
        const types = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        res.setHeader(
          "Content-Type",
          types[path.extname(file)] || "application/octet-stream",
        );
        res.end(req.method === "HEAD" ? undefined : await readFile(file));
      } catch {
        throw new ApiError(404, "먼저 npm run build를 실행해 주세요.");
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, error instanceof ApiError ? error.status : 500, {
        message:
          error instanceof ApiError
            ? error.message
            : "서버 처리를 마치지 못했습니다.",
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return {
    server,
    store,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...pendingJobs]);
      store.close();
    },
  };
}
