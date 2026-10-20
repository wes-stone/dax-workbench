export function markdownUrl(url: string): string {
  if (!/^(https?:\/\/|mailto:)/i.test(url) || /[\u0000-\u0020\u007f]/u.test(url)) return "";
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return "";
    return url;
  } catch {
    return "";
  }
}

/** Managed image destinations are opaque catalog IDs, never paths or URLs. */
export function markdownArtifactId(url: string): string | null {
  return /^artifact:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(url)?.[1] ?? null;
}
