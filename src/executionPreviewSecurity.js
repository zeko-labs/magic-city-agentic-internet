const PREVIEW_BASE = 'https://magic-city-preview.invalid';

export function normalizeExecutionPreviewUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  let parsed;
  try {
    parsed = new URL(raw, PREVIEW_BASE);
  } catch {
    return '';
  }
  if (parsed.username || parsed.password) return '';
  if (parsed.origin === PREVIEW_BASE) {
    return parsed.pathname.startsWith('/artifacts/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '';
  }
  return parsed.protocol === 'https:' ? parsed.href : '';
}

export function sanitizeExecutionPreviewMetadata(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeExecutionPreviewMetadata(entry));
  if (!value || typeof value !== 'object') return value;
  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'previewArtifact' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const url = normalizeExecutionPreviewUrl(entry.url);
      sanitized[key] = url
        ? { ...sanitizeExecutionPreviewMetadata(entry), url }
        : null;
      continue;
    }
    sanitized[key] = sanitizeExecutionPreviewMetadata(entry);
  }
  return sanitized;
}
