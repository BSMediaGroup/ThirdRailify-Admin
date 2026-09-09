// Retry reads only: replaying a save, vote or upload could duplicate a mutation.
export async function fetchWithReadRetry(input: string, init: RequestInit = {}): Promise<Response> {
  const read = ['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(input, { ...init, signal: init.signal || AbortSignal.timeout(16_000) });
      if (!read || attempt === 2 || ![502, 503, 504].includes(response.status)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (!read || attempt === 2 || init.signal?.aborted) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt + Math.random() * 200));
    if (init.signal?.aborted) throw init.signal.reason;
  }
}
