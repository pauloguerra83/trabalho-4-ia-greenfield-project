/**
 * `attachment` disposition for a user-supplied file name (RFC 6266): an
 * ASCII-safe `filename` fallback plus the UTF-8 `filename*` form.
 */
export function attachmentDisposition(fileName: string): string {
  const asciiFallback =
    fileName.replace(/[^\x20-\x7e]|["\\]/g, '_').trim() || 'video';
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
