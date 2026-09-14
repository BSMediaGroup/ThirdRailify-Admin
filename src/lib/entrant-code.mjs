export const ENTRANT_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ENTRANT_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$/;

export function normalizeEntrantCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return ENTRANT_CODE_PATTERN.test(code) ? code : null;
}

export function generateEntrantCode(fill = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(7);
  fill(bytes);
  return Array.from(bytes, (byte) => ENTRANT_CODE_ALPHABET[byte & 31]).join('');
}
