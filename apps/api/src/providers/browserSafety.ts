/** Location metadata never carries login codes, viewer tokens, or inline documents. */
export function browserLocation(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:' || url.protocol === 'javascript:') return 'about:blank';
    if (url.protocol === 'file:') return 'file://local-document/';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'about:blank';
  }
}

/** Vendor connection exceptions sometimes embed their tokenized CDP URL. */
export function browserFailure(
  error: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets)
    if (secret) {
      message = message
        .replaceAll(secret, '[redacted]')
        .replaceAll(encodeURIComponent(secret), '[redacted]');
    }
  return message
    .replace(/([?&](?:token|apikey|api_key|key)=)[^&\s"']+/gi, '$1[redacted]')
    .slice(0, 1200);
}
