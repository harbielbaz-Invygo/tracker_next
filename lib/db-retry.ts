/**
 * Retry a read-only DB operation on a TRANSIENT connection error.
 *
 * The remote libSQL/Turso transport is HTTP with keep-alive. Serverless +
 * idle keep-alive sockets mean the remote occasionally closes a socket the
 * client then tries to reuse — undici surfaces this as
 * `TypeError: fetch failed` with `cause.code === "UND_ERR_SOCKET"`
 * ("other side closed", bytesRead: 0). Because the socket dropped before
 * any response, the statement never produced a result — a fresh attempt on
 * a new socket almost always succeeds.
 *
 * Use ONLY around read-only work (page data loaders). The drop happens
 * before a response, so for a SELECT a retry is always safe. Do NOT wrap
 * writes/transactions with this — a write could in principle have been
 * applied server-side before the socket closed, and a blind retry would
 * double-apply it.
 */

const TRANSIENT = /fetch failed|UND_ERR_SOCKET|other side closed|ECONNRESET|socket hang ?up|terminated|EPIPE|ETIMEDOUT/i;

function isTransient(err: unknown): boolean {
  let e: unknown = err;
  // Walk the cause chain — the useful signal is usually on `cause`.
  for (let depth = 0; e && depth < 5; depth++) {
    const anyE = e as { message?: unknown; code?: unknown; cause?: unknown };
    const msg = typeof anyE.message === "string" ? anyE.message : "";
    const code = typeof anyE.code === "string" ? anyE.code : "";
    if (TRANSIENT.test(msg) || TRANSIENT.test(code)) return true;
    e = anyE.cause;
  }
  return false;
}

export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isTransient(err)) throw err;
      // Brief escalating backoff before re-trying on a fresh socket.
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}
