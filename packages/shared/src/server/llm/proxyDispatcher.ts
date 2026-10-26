// ── LITEFUSE ADDITION: one proxy rule for both decision-model clients ───────
// A raw `fetch` ignores HTTP(S)_PROXY, so the decision-model clients build an
// undici `ProxyAgent` from `HTTPS_PROXY` themselves (same variable the
// LLM-judge path honours). Loopback endpoints — a self-hosted vLLM behind
// `http://127.0.0.1:8000/v1`, or a test double — must NOT go through it:
// undici's ProxyAgent ignores NO_PROXY, so without this check a local endpoint
// becomes unreachable as soon as a proxy is configured.
// ────────────────────────────────────────────────────────────────────────────

import { ProxyAgent, type Dispatcher } from "undici";
import { env } from "../../env";

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** `undefined` means "call the endpoint directly". */
export function decisionModelProxyDispatcher(
  targetUrl: string,
): Dispatcher | undefined {
  if (isLoopbackUrl(targetUrl)) return undefined;
  const proxyUrl = env.HTTPS_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}
