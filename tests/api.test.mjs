import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { request as rawRequest } from "node:http";
import { createApp } from "../server/app.mjs";
import { readConfig, hashPassword } from "../server/config.mjs";
const password = "synthetic-test-password";
const hash = await hashPassword(password);
const document = () => ({
  mode: "record",
  source: "mic",
  sourceLanguage: "ko",
  targetLanguage: "en",
  durationMs: 0,
  rows: [],
  transcribe: false,
});
async function fixture(t, extra = {}, transport) {
  await mkdir("data", { recursive: true });
  const dir = await mkdtemp("data/api-test-");
  const config = {
    ...readConfig({
      OWNER_LOGIN: "owner",
      OWNER_PASSWORD_HASH: hash,
      SESSION_SECRET: "a".repeat(64),
      DATA_DIR: dir,
    }),
    ...extra,
  };
  const app = createApp(config, { transport });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  config.baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  let cookie = "",
    csrf = "";
  async function request(p, method = "GET", value, headers = {}) {
    const response = await fetch(config.baseUrl + p, {
      method,
      headers: {
        Origin: config.baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": Buffer.isBuffer(value)
          ? "application/octet-stream"
          : "application/json",
        ...headers,
      },
      body: ["GET", "HEAD"].includes(method)
        ? undefined
        : Buffer.isBuffer(value)
          ? value
          : JSON.stringify(value ?? {}),
    });
    return response;
  }
  async function login() {
    const res = await request("/api/login", "POST", {
      login: "owner",
      password,
    });
    assert.equal(res.status, 200);
    cookie = res.headers.get("set-cookie").split(";")[0];
    csrf = (await res.json()).csrf;
  }
  const base = "/api/workspaces/local/meetings";
  async function create(doc = document()) {
    const res = await request(base, "POST", {
      id: randomUUID(),
      title: "Synthetic meeting",
      mimeType: "audio/webm;codecs=opus",
      document: doc,
    });
    assert.equal(res.status, 201);
    return res.json();
  }
  async function complete(m) {
    const res = await request(`${base}/${m.id}/complete`, "POST", {
      revision: m.revision,
      chunks: m.chunks.length,
    });
    assert.equal(res.status, 200);
    return res.json();
  }
  return { app, config, request, login, create, complete, base };
}
test("configuration fails closed without credentials or with remote HTTP", () => {
  assert.throws(() => readConfig({}));
  assert.throws(() =>
    readConfig({
      OWNER_LOGIN: "owner",
      OWNER_PASSWORD_HASH: hash,
      SESSION_SECRET: "a".repeat(64),
      BASE_URL: "http://example.com",
    }),
  );
});
test("authentication, CSRF, workspace and static-file boundaries", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(f.base)).status, 401);
  assert.equal(
    (
      await f.request(
        "/api/login",
        "POST",
        { login: "owner", password },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/login", "POST", {
        login: "owner",
        password: "wrong",
      })
    ).status,
    401,
  );
  await f.login();
  const summary = await (await f.request("/api/session")).json();
  assert.equal(summary.login, "owner");
  assert.equal("passwordHash" in summary, false);
  assert.equal("secret" in summary, false);
  assert.equal(
    (await f.request(f.base, "POST", {}, { "X-CSRF-Token": "" })).status,
    403,
  );
  assert.equal((await f.request("/api/workspaces/other/meetings")).status, 404);
  assert.equal((await f.request("/.env")).status, 404);
  assert.equal((await f.request("/server/config.mjs")).status, 404);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = rawRequest(
      f.config.baseUrl + "/api/session",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal(
    (
      await f.request("/api/session", "GET", undefined, {
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal((await f.request("/api/logout", "POST")).status, 204);
  assert.equal((await f.request(f.base)).status, 401);
});
test("chunk retries, final transcript, revisions, contiguous completion, audio range and deletion", async (t) => {
  const f = await fixture(t);
  await f.login();
  let m = await f.create();
  const p = `${f.base}/${m.id}`;
  assert.equal(
    (await f.request(p + "/chunks/1", "PUT", Buffer.from("world"))).status,
    204,
  );
  assert.equal(
    (await f.request(p + "/complete", "POST", { revision: 0, chunks: 1 }))
      .status,
    409,
  );
  assert.equal(
    (await f.request(p + "/chunks/0", "PUT", Buffer.from("hello"))).status,
    204,
  );
  assert.equal(
    (await f.request(p + "/chunks/0", "PUT", Buffer.from("hello"))).status,
    204,
  );
  assert.equal(
    (await f.request(p + "/chunks/0", "PUT", Buffer.from("changed"))).status,
    409,
  );
  m.document.rows.push({
    id: randomUUID(),
    startMs: 0,
    endMs: 1000,
    original: "마지막 확정 발언",
    translation: "",
    bookmark: false,
  });
  m = await (
    await f.request(p, "PUT", {
      title: m.title,
      revision: 0,
      document: m.document,
    })
  ).json();
  assert.equal(
    (
      await f.request(p, "PUT", {
        title: m.title,
        revision: 0,
        document: m.document,
      })
    ).status,
    409,
  );
  m = await f.complete(m);
  assert.equal(m.state, "COMPLETED");
  assert.equal(m.document.rows[0].original, "마지막 확정 발언");
  assert.equal(
    (await f.request(p + "/chunks/2", "PUT", Buffer.from("late"))).status,
    409,
  );
  const res = await f.request(p + "/audio", "GET", undefined, {
    Range: "bytes=3-7",
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 3-7/10");
  assert.equal(await res.text(), "lowor");
  assert.equal(
    (await f.request(p + "/audio", "GET", undefined, { Range: "bytes=10-20" }))
      .status,
    416,
  );
  assert.equal((await f.request(p + "/discard", "POST")).status, 409);
  assert.equal((await f.request(p, "DELETE")).status, 204);
  assert.equal((await f.request(p + "/audio")).status, 404);
  assert.equal(
    f.app.store.db.prepare("SELECT count(*) AS n FROM chunks").get().n,
    0,
  );
});
test("discard is idempotent and never deletes another meeting", async (t) => {
  const f = await fixture(t);
  await f.login();
  const a = await f.create(),
    b = await f.create();
  await f.request(
    `${f.base}/${a.id}/chunks/0`,
    "PUT",
    Buffer.from("discard me"),
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.request(`${f.base}/${a.id}/discard`, "POST")).status,
      204,
    );
  assert.equal(
    (await f.request(`${f.base}/${a.id}/chunks/1`, "PUT", Buffer.from("late")))
      .status,
    404,
  );
  assert.equal((await f.request(`${f.base}/${b.id}`)).status, 200);
});
test("transcript validation rejects duplicate IDs and oversized recording duration", async (t) => {
  const f = await fixture(t);
  await f.login();
  const m = await f.create();
  const row = {
    id: randomUUID(),
    startMs: 0,
    endMs: 1,
    original: "x",
    translation: "",
    bookmark: false,
  };
  assert.equal(
    (
      await f.request(`${f.base}/${m.id}`, "PUT", {
        title: "test",
        revision: 0,
        document: { ...document(), rows: [row, row] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(`${f.base}/${m.id}`, "PUT", {
        title: "test",
        revision: 0,
        document: { ...document(), durationMs: 10 * 3600_000 },
      })
    ).status,
    400,
  );
});
test("provider requests use only temporary client keys and configured server credentials", async (t) => {
  let payload;
  const f = await fixture(
    t,
    { sonioxKey: "test-server-credential", sonioxRegion: "eu" },
    async (url, options) => {
      assert.equal(url, "https://api.eu.soniox.com/v1/auth/temporary-api-key");
      assert.equal(
        options.headers.Authorization,
        "Bearer test-server-credential",
      );
      payload = JSON.parse(options.body);
      return Response.json({ api_key: "test-temporary" });
    },
  );
  await f.login();
  const m = await f.create();
  const res = await f.request(`${f.base}/${m.id}/speech-token`, "POST");
  assert.equal(res.status, 200);
  const token = await res.json();
  assert.equal(token.apiKey, "test-temporary");
  assert.equal(
    token.websocketUrl,
    "wss://stt-rt.eu.soniox.com/transcribe-websocket",
  );
  assert.equal(payload.single_use, true);
  assert.equal(payload.expires_in_seconds, 60);
  assert.equal(payload.max_session_duration_seconds, 7200);
  const conf = await (await f.request("/api/session")).text();
  assert.equal(conf.includes("test-server-credential"), false);
});
async function awaitJob(f, id) {
  for (let i = 0; i < 100; i++) {
    const result = await (await f.request("/api/jobs/" + id)).json();
    if (result.state !== "RUNNING") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("job did not settle");
}
function aiResponse(result) {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(result) }],
      },
    ],
  });
}
test("AI summary is durable, editable, preserves origin; correction validates source IDs", async (t) => {
  let mode = "summary";
  let sourceId;
  const f = await fixture(
    t,
    {
      aiProvider: "oci",
      aiKey: "test-key",
      aiProject: "test-project",
      aiModel: "xai.grok-4.6",
    },
    async (url, options) => {
      assert.equal(
        url,
        "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1/responses",
      );
      assert.equal(options.headers["OpenAI-Project"], "test-project");
      assert.equal(JSON.parse(options.body).store, false);
      return aiResponse(
        mode === "summary"
          ? { summary: "핵심", minutes: "검토하기로 함.", onePage: "다음 단계" }
          : { rows: [{ id: sourceId, text: "Oracle" }] },
      );
    },
  );
  await f.login();
  const doc = document();
  sourceId = randomUUID();
  doc.rows = [
    {
      id: sourceId,
      startMs: 0,
      endMs: 1,
      original: "오라클",
      translation: "",
      bookmark: false,
    },
  ];
  let m = await f.complete(await f.create(doc));
  const p = `${f.base}/${m.id}`;
  let res = await f.request(p + "/ai", "POST", { task: "summary" });
  assert.equal(res.status, 202);
  assert.equal((await awaitJob(f, (await res.json()).id)).state, "COMPLETED");
  m = await (await f.request(p)).json();
  assert.equal(m.review.minutes, "검토하기로 함.");
  const saved = await f.request(p + "/review", "PUT", {
    revision: m.revision,
    title: m.title,
    summary: "사람이 편집",
    minutes: m.review.minutes,
    onePage: m.review.onePage,
  });
  assert.equal(saved.status, 200);
  m = await saved.json();
  mode = "correct";
  res = await f.request(p + "/ai", "POST", { task: "correct" });
  assert.equal((await awaitJob(f, (await res.json()).id)).state, "COMPLETED");
  m = await (await f.request(p)).json();
  assert.equal(m.document.rows[0].original, "오라클");
  assert.equal(m.review.correctedRows[0].text, "Oracle");
  assert.equal(m.review.summary, "사람이 편집");
  sourceId = randomUUID();
  res = await f.request(p + "/ai", "POST", { task: "correct" });
  assert.equal((await awaitJob(f, (await res.json()).id)).state, "FAILED");
});
test("AI cannot resurrect a deleted meeting or overwrite a concurrent human edit", async (t) => {
  let release;
  const f = await fixture(
    t,
    { aiProvider: "openai", aiKey: "test-key", aiModel: "test-model" },
    async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return aiResponse({ summary: "AI", minutes: "AI", onePage: "AI" });
    },
  );
  await f.login();
  const doc = document();
  doc.rows = [
    {
      id: randomUUID(),
      startMs: 0,
      endMs: 1,
      original: "test",
      translation: "",
      bookmark: false,
    },
  ];
  let m = await f.complete(await f.create(doc));
  let p = `${f.base}/${m.id}`;
  const j = await (
    await f.request(p + "/ai", "POST", { task: "summary" })
  ).json();
  assert.equal(
    (await f.request(p + "/ai", "POST", { task: "summary" })).status,
    409,
  );
  await f.request(p + "/review", "PUT", {
    revision: m.revision,
    title: m.title,
    summary: "human",
    minutes: "",
    onePage: "",
  });
  release();
  assert.equal((await awaitJob(f, j.id)).state, "FAILED");
  assert.equal((await (await f.request(p)).json()).review.summary, "human");
  m = await f.complete(await f.create(doc));
  p = `${f.base}/${m.id}`;
  await f.request(p + "/ai", "POST", { task: "summary" });
  await f.request(p, "DELETE");
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await f.request(p)).status, 404);
});
test("provider errors are redacted and surfaced as failed jobs", async (t) => {
  const f = await fixture(
    t,
    { aiProvider: "openai", aiKey: "test-secret", aiModel: "test-model" },
    async () => new Response("sensitive-provider-response", { status: 401 }),
  );
  await f.login();
  const doc = document();
  doc.rows = [
    {
      id: randomUUID(),
      startMs: 0,
      endMs: 1,
      original: "test",
      translation: "",
      bookmark: false,
    },
  ];
  const m = await f.complete(await f.create(doc));
  const j = await (
    await f.request(`${f.base}/${m.id}/ai`, "POST", { task: "summary" })
  ).json();
  const result = await awaitJob(f, j.id);
  assert.equal(result.state, "FAILED");
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});
test("TTS requires configured translation and uses the selected language", async (t) => {
  const f = await fixture(
    t,
    { sonioxKey: "test-only" },
    async (url, options) => {
      assert.equal(url, "https://tts-rt.soniox.com/tts");
      assert.equal(JSON.parse(options.body).language, "ja");
      assert.equal(JSON.parse(options.body).text, "こんにちは");
      return new Response(Buffer.from("synthetic-mp3"), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  );
  await f.login();
  const a = await f.create();
  assert.equal(
    (
      await f.request(`${f.base}/${a.id}/synthesize`, "POST", {
        text: "こんにちは",
      })
    ).status,
    400,
  );
  const b = await f.create({
    ...document(),
    mode: "translate",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    translateKorean: true,
    speakTranslation: true,
  });
  const res = await f.request(`${f.base}/${b.id}/synthesize`, "POST", {
    text: "こんにちは",
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
});
test("restart preserves meetings and resolves interrupted AI jobs as failed", async (t) => {
  await mkdir("data", { recursive: true });
  const dir = await mkdtemp("data/restart-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { openStore } = await import("../server/store.mjs");
  let store = openStore(dir);
  const originalSubject = store.subject;
  const id = randomUUID();
  store.save({
    id,
    title: "Restart fixture",
    state: "COMPLETED",
    revision: 1,
    document: document(),
    chunks: [],
  });
  store.db
    .prepare("INSERT INTO jobs VALUES(?,?,?,'RUNNING',NULL,?)")
    .run(randomUUID(), id, "summary", Date.now());
  store.close();
  store = openStore(dir);
  try {
    assert.equal(store.subject, originalSubject);
    assert.equal(store.get(id).title, "Restart fixture");
    assert.equal(store.get(id).aiJob.state, "FAILED");
  } finally {
    store.close();
  }
});
