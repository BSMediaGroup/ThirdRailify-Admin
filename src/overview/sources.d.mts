export type SourceId = 'status' | 'analytics' | 'commerce' | 'watch' | 'goats' | 'banner' | 'automations';
export type SourceResult = { outcome: 'pending' | 'not_applicable' | 'success' | 'failure' | 'cancelled'; data?: unknown; attemptAt?: string; lastSuccess?: string | null; durationMs?: number; deadlineMs?: number; httpStatus?: number; reference?: string | null; error?: {category: string; code: string | null; message: string; retryAfterMs: number | null} | null };
export type SourceState = SourceResult & { id: SourceId; label: string; route: string; to: string; method?: string; generation: number; failures: number; nextRetry: number | null };
export const SOURCES: Record<SourceId, {label: string; route: string; to: string; method?: string}>;
export function initialSources(eligible: SourceId[]): Record<SourceId, SourceState>;
export function readSource(id: SourceId, options?: {signal?: AbortSignal; csrfToken?: string; deadlineMs?: number; fetcher?: typeof fetch; now?: () => number}): Promise<SourceResult>;
export function acceptResult(previous: SourceState, result: SourceResult, generation: number, now?: number): SourceState;
export function deriveSources(sources: Record<SourceId, SourceState>): {eligible: SourceState[]; failed: SourceState[]; sessionExpired: boolean; reporting: number; expected: number};
export function classifyError(status: number, code: string | null): string;
