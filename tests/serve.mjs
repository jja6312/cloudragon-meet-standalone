// Isolated synthetic provider for browser tests only. Never imported by server/index.mjs.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../server/app.mjs";
import { hashPassword, readConfig } from "../server/config.mjs";
await mkdir("data", { recursive: true });
const dir = await mkdtemp("data/browser-test-");
const config = readConfig({
  BASE_URL: "http://127.0.0.1:4189",
  OWNER_LOGIN: "owner",
  OWNER_PASSWORD_HASH: await hashPassword("synthetic-test-password"),
  SESSION_SECRET: "b".repeat(64),
  DATA_DIR: dir,
  SONIOX_API_KEY: "test-only",
  AI_PROVIDER: "openai",
  AI_API_KEY: "test-only",
  AI_MODEL: "test-only",
});
const app = createApp(config, {
  transport: async (url) => {
    if (url.includes("temporary-api-key"))
      return Response.json({ api_key: "test-temporary" });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                summary: "자동 요약 성공",
                minutes: "다음 주 검토하기로 함.",
                onePage: "결정 · 다음 단계",
              }),
            },
          ],
        },
      ],
    });
  },
});
app.server.listen(4189, "127.0.0.1");
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await rm(dir, { recursive: true, force: true });
    process.exit(0);
  });
