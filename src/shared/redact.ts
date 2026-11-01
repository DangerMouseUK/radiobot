const SENSITIVE_PARAM =
  /(token|key|sig|signature|auth|secret|session|password|pass|pwd|hash|expires|policy|credential|jwt|access)/i;

/**
 * Produces a display/log-safe form of a URL: never includes userinfo, and replaces
 * the value of every query parameter with "***" (parameters with obviously sensitive
 * names are collapsed entirely). Fragments are dropped.
 */
export function redactUrl(raw: string | URL | null | undefined): string {
  if (!raw) return '';
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : new URL(raw.href);
  } catch {
    return '[invalid-url]';
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  const keys = [...new Set(url.searchParams.keys())];
  if (keys.length > 0) {
    const shown = keys.map((k) => (SENSITIVE_PARAM.test(k) ? '***' : `${k}=***`));
    return `${url.origin}${url.pathname}?${shown.join('&')}`;
  }
  return `${url.origin}${url.pathname}`;
}

/** Host-only form, used where even the path could identify a private resource. */
export function urlHost(raw: string | URL | null | undefined): string {
  if (!raw) return '';
  try {
    return (typeof raw === 'string' ? new URL(raw) : raw).host;
  } catch {
    return '[invalid-url]';
  }
}

const DISCORD_TOKEN_RE = /[MNO][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,}/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/** Scrubs free text (error messages, ffmpeg stderr) of tokens and credential-bearing URLs. */
export function redactText(text: string, extraSecrets: readonly string[] = []): string {
  let out = text.replace(DISCORD_TOKEN_RE, '[redacted-token]').replace(URL_RE, (m) => redactUrl(m));
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}
