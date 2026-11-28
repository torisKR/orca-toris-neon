/** An error as callers may see it: a known code and a bounded message with secrets redacted. */
export function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'action_failed',
    message: String(error?.message || '요청을 완료하지 못했습니다.')
      .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[redacted]')
      .replace(/(Bearer\s+|(?:access_token|private_key|client_secret)\s*[:=]\s*)[^\s,]+/gi, '$1[redacted]')
      .slice(0, 1200)
  };
}
