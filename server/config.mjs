import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
const derive = promisify(scrypt);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  const [salt, expected] = encoded.split(":");
  const hash = await derive(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(hash, Buffer.from(expected, "hex"));
}
export function readConfig(env = process.env) {
  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(env.OWNER_LOGIN || ""))
    throw new Error("Run npm run setup: OWNER_LOGIN is missing or invalid.");
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(env.OWNER_PASSWORD_HASH || ""))
    throw new Error("Run npm run setup: password hash is missing.");
  if (!/^[a-f0-9]{64}$/.test(env.SESSION_SECRET || ""))
    throw new Error("Run npm run setup: session secret is missing.");
  const base = new URL(env.BASE_URL || "http://localhost:8088");
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !["http:", "https:"].includes(base.protocol)
  )
    throw new Error("BASE_URL must be an origin without a path.");
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new Error("Remote access requires HTTPS.");
  const region = env.SONIOX_REGION || "us";
  if (!["us", "eu", "jp"].includes(region))
    throw new Error("SONIOX_REGION must be us, eu or jp.");
  const aiProvider = env.AI_PROVIDER || "none";
  if (!["none", "oci", "openai"].includes(aiProvider))
    throw new Error("AI_PROVIDER must be none, oci or openai.");
  const ociRegion = env.OCI_GENAI_REGION || "us-chicago-1";
  if (!["us-ashburn-1", "us-chicago-1", "us-phoenix-1"].includes(ociRegion))
    throw new Error("Unsupported OCI Generative AI region.");
  if (
    aiProvider !== "none" &&
    (!env.AI_API_KEY ||
      !env.AI_MODEL ||
      (aiProvider === "oci" && !env.OCI_GENAI_PROJECT))
  )
    throw new Error(
      "AI provider requires AI_API_KEY, AI_MODEL and (OCI only) OCI_GENAI_PROJECT.",
    );
  const port = Number(env.PORT || 8088);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  return {
    baseUrl: base.origin,
    host: env.HOST || "127.0.0.1",
    port,
    login: env.OWNER_LOGIN,
    passwordHash: env.OWNER_PASSWORD_HASH,
    secret: env.SESSION_SECRET,
    dataDir: path.resolve(env.DATA_DIR || "data"),
    distDir: path.resolve("dist"),
    sonioxKey: env.SONIOX_API_KEY || "",
    sonioxRegion: region,
    aiProvider,
    aiKey: env.AI_API_KEY || "",
    aiModel: env.AI_MODEL || "",
    ociRegion,
    aiProject: env.OCI_GENAI_PROJECT || "",
  };
}
