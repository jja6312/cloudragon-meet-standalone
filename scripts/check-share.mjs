import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const problems = [];
for (const file of files) {
  if (
    (/(^|\/)\.env(?:\.|$)/.test(file) && file !== ".env.example") ||
    /(^|\/)(data|private|wallet|node_modules|dist|infra|products)(\/|$)/.test(
      file,
    ) ||
    /\.(pem|key|p12|apk|sqlite(?:-wal|-shm)?)$/i.test(file)
  )
    problems.push(`Private/generated path: ${file}`);
  if (/\.(?:mjs|tsx?|css|md|json|yaml|html)$/.test(file)) {
    const source = readFileSync(file, "utf8");
    if (
      /(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ocid1\.[a-z]+\.[a-z0-9.-]{45,})/.test(
        source,
      )
    )
      problems.push(`Credential/real resource marker: ${file}`);
    if (/https?:\/\/(?:[a-z]+\.)?cloudragon\.cloud/.test(source))
      problems.push(`Production service dependency: ${file}`);
  }
}
const template = readFileSync(".env.example", "utf8");
for (const key of [
  "OWNER_PASSWORD_HASH",
  "SESSION_SECRET",
  "SONIOX_API_KEY",
  "AI_API_KEY",
  "OCI_GENAI_PROJECT",
]) {
  if (!new RegExp(`^${key}=$`, "m").test(template))
    problems.push(`Template must leave ${key} blank`);
}
const context = readFileSync(".dockerignore", "utf8");
if (!context.startsWith("**\n") || context.includes("!.env"))
  problems.push("Docker context must exclude credentials by default");
if (!files.length) problems.push("No shareable source files found");
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Share boundary PASS: ${files.length} source files; private/generated paths excluded; blank credentials; no production host dependency.`,
  );
