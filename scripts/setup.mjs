import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hashPassword, readConfig } from "../server/config.mjs";
process.umask(0o077);
if (existsSync(".env") && !process.argv.includes("--update")) {
  console.error(
    "설정이 이미 있습니다. 변경하려면 npm run setup -- --update를 실행하세요.",
  );
  process.exit(1);
}
if (existsSync(".env")) process.loadEnvFile(".env");
let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  },
});
const rl = createInterface({
  input: process.stdin,
  output,
  terminal: Boolean(process.stdin.isTTY),
});
async function ask(label, previous = "", secret = false) {
  const hint = previous
    ? secret
      ? " [설정됨 · Enter로 유지]"
      : ` [${previous}]`
    : "";
  process.stdout.write(label + hint + ": ");
  muted = secret;
  let answer;
  try {
    answer = (await rl.question("")).trim();
  } finally {
    muted = false;
    if (secret) process.stdout.write("\n");
  }
  return answer || previous;
}
const old = process.env;
try {
  console.log(
    "Cloudragon Meet — 독립 설치 설정 (비밀값은 파일에만 저장됩니다)",
  );
  const values = {};
  values.BASE_URL = await ask(
    "접속 URL",
    old.BASE_URL || "http://localhost:8088",
  );
  values.PORT = await ask("서버 포트", old.PORT || "8088");
  values.HOST = old.HOST || "127.0.0.1";
  values.DATA_DIR = old.DATA_DIR || "./data";
  values.OWNER_LOGIN = await ask("로그인 아이디", old.OWNER_LOGIN || "owner");
  const password = await ask(
    "로그인 비밀번호 (12자 이상, 변경하지 않으면 Enter)",
    "",
    true,
  );
  if (password) {
    if (password.length < 12 || password.length > 1024)
      throw new Error("비밀번호는 12~1024자로 지정하세요.");
    if (password !== (await ask("비밀번호 확인", "", true)))
      throw new Error("비밀번호가 일치하지 않습니다.");
    values.OWNER_PASSWORD_HASH = await hashPassword(password);
  } else if (old.OWNER_PASSWORD_HASH)
    values.OWNER_PASSWORD_HASH = old.OWNER_PASSWORD_HASH;
  else throw new Error("첫 설치에는 비밀번호가 필요합니다.");
  // Rotate the secret on each setup so prior sessions cannot survive account changes.
  values.SESSION_SECRET = randomBytes(32).toString("hex");
  values.SONIOX_API_KEY = await ask(
    "Soniox API 키 (없으면 Enter: 녹음만 사용)",
    old.SONIOX_API_KEY || "",
    true,
  );
  values.SONIOX_REGION = await ask(
    "Soniox 리전 us/eu/jp",
    old.SONIOX_REGION || "us",
  );
  values.AI_PROVIDER = await ask(
    "AI 제공자 none/oci/openai",
    old.AI_PROVIDER || "none",
  );
  values.AI_API_KEY = "";
  values.AI_MODEL = "";
  values.OCI_GENAI_REGION = old.OCI_GENAI_REGION || "us-chicago-1";
  values.OCI_GENAI_PROJECT = "";
  if (values.AI_PROVIDER !== "none") {
    const sameProvider = values.AI_PROVIDER === old.AI_PROVIDER;
    values.AI_API_KEY = await ask(
      "AI API 키",
      sameProvider ? old.AI_API_KEY || "" : "",
      true,
    );
    values.AI_MODEL = await ask(
      "AI 모델 ID",
      (sameProvider ? old.AI_MODEL : "") ||
        (values.AI_PROVIDER === "oci" ? "xai.grok-4.6" : ""),
    );
    if (values.AI_PROVIDER === "oci") {
      values.OCI_GENAI_REGION = await ask(
        "OCI Generative AI 리전",
        values.OCI_GENAI_REGION,
      );
      values.OCI_GENAI_PROJECT = await ask(
        "OCI Generative AI 프로젝트 ID",
        old.OCI_GENAI_PROJECT || "",
        true,
      );
    }
  }
  readConfig(values);
  const lines = Object.entries(values).map(([key, value]) => {
    if (/[\r\n']/.test(value))
      throw new Error(`${key}: 줄바꿈 또는 작은따옴표는 사용할 수 없습니다.`);
    return `${key}='${value}'`;
  });
  writeFileSync(".env.new", lines.join("\n") + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(".env.new", ".env");
  console.log(
    "설정 완료. npm run build 후 npm start로 시작하세요. 기존 실행 중인 서버는 재시작해야 합니다.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
