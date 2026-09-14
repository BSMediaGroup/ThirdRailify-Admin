export const ENTRANT_CODE_ALPHABET: string;
export const ENTRANT_CODE_PATTERN: RegExp;
export function normalizeEntrantCode(value: unknown): string | null;
export function generateEntrantCode(fill?: (bytes: Uint8Array) => Uint8Array | void): string;
