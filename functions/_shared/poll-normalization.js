const OUTER_WHITESPACE = /^\s+|\s+$/gu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export function normalizePollTrigger(value) {
  if (typeof value !== "string") throw new TypeError("Poll trigger must be a string.");
  return value.normalize("NFKC").replace(OUTER_WHITESPACE, "").toLowerCase();
}

export function validatePollTrigger(value, maximum = 64) {
  const normalized = normalizePollTrigger(value);
  if (!normalized || normalized.length > maximum || CONTROL.test(normalized)) return null;
  return normalized;
}
