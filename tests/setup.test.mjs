import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
const script = path.resolve("scripts/setup.mjs");
test("setup generates a private hashed configuration and updates without exposing keys", async (t) => {
  await mkdir("data", { recursive: true });
  const dir = await mkdtemp("data/setup-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  async function wizard(update, steps) {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(OWNER_|SESSION_|SONIOX_|AI_|OCI_GENAI_|BASE_URL|PORT|HOST|DATA_DIR)/.test(
            key,
          ),
      ),
    );
    const child = spawn(
      process.execPath,
      [script, ...(update ? ["--update"] : [])],
      { cwd: dir, env: clean, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      index = 0;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (index < steps.length && output.includes(steps[index][0])) {
        child.stdin.write(steps[index++][1] + "\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("setup timed out"));
      }, 10_000);
      child.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(code, 0, output);
    assert.equal(index, steps.length);
    return output;
  }
  const password = "synthetic-setup-password";
  let output = await wizard(false, [
    ["접속 URL", ""],
    ["서버 포트", ""],
    ["로그인 아이디", "tester"],
    ["로그인 비밀번호", password],
    ["비밀번호 확인", password],
    ["Soniox API 키", ""],
    ["Soniox 리전", ""],
    ["AI 제공자", "none"],
  ]);
  const initial = await readFile(path.join(dir, ".env"), "utf8");
  assert.equal(initial.includes(password), false);
  assert.equal(output.includes(password), false);
  assert.match(initial, /OWNER_PASSWORD_HASH='[a-f0-9]{32}:[a-f0-9]{128}'/);
  assert.equal((await stat(path.join(dir, ".env"))).mode & 0o777, 0o600);
  output = await wizard(true, [
    ["접속 URL", ""],
    ["서버 포트", ""],
    ["로그인 아이디", ""],
    ["로그인 비밀번호", ""],
    ["Soniox API 키", ""],
    ["Soniox 리전", ""],
    ["AI 제공자", "none"],
  ]);
  const updated = await readFile(path.join(dir, ".env"), "utf8");
  assert.equal(
    updated.match(/OWNER_PASSWORD_HASH=.*/)[0],
    initial.match(/OWNER_PASSWORD_HASH=.*/)[0],
  );
  assert.notEqual(
    updated.match(/SESSION_SECRET=.*/)[0],
    initial.match(/SESSION_SECRET=.*/)[0],
  );
  assert.equal(output.includes(password), false);
});
