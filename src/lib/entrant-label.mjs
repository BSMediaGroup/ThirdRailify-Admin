const CONTROL = /[\p{Cc}\p{Cf}]/u;

export function normalizeEntrySuffix(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || CONTROL.test(value)) throw new Error('Entry suffix must be plain text.');
  const suffix = value.trim().replace(/\s+/g, ' ');
  if (!suffix || suffix.length > 32) throw new Error('Entry suffix must contain 1-32 characters.');
  return suffix;
}

export function entryDisplayLabel(entry, showSuffix = true) {
  const label = String(entry?.label || '').trim();
  const suffix = normalizeEntrySuffix(entry?.suffix);
  return showSuffix && suffix ? `${label} ${suffix}` : label;
}

export function entryAccessibleLabel(entry) {
  return entryDisplayLabel(entry, true);
}
