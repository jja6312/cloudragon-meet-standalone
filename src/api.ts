let csrf = "";
export const setCsrf = (value: string) => {
  csrf = value;
};
export async function apiRequest<T = void>(
  path: string,
  method = "GET",
  value?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET"
        ? { "X-CSRF-Token": csrf, "Content-Type": "application/json" }
        : {}),
    },
    body: method !== "GET" ? JSON.stringify(value ?? {}) : undefined,
  });
  await check(response);
  return response.status === 204 ? (undefined as T) : response.json();
}
async function check(response: Response) {
  if (response.ok) return;
  const error = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  throw new Error(
    error.message || `요청을 처리하지 못했습니다 (${response.status}).`,
  );
}
export async function apiUpload(path: string, blob: Blob) {
  const response = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "X-CSRF-Token": csrf,
      "Content-Type": "application/octet-stream",
    },
    body: blob,
  });
  await check(response);
}
export async function apiBlob(
  path: string,
  value: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(path, {
    method: "POST",
    signal,
    credentials: "same-origin",
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  await check(response);
  return {
    blob: await response.blob(),
    provider: response.headers.get("X-Speech-Provider") || "soniox",
  };
}
