/** Pauses do not consume captured audio time. Native Android shares this limit. */
export const MAX_RECORDING_MS = 9 * 60 * 60 * 1000;

export function retryableSpeechError(code: number, type?: string) {
  return (
    ![401, 402, 403].includes(code) ||
    (code === 403 && type === "temp_api_key_session_expired")
  );
}
