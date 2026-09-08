export type Contender = { id: string; name: string; seed: number | null; description: string; notes?: string; tags?: string; image: string | null };
export type Slot = { id: string; kind: 'winner' | 'contender' | 'bye' | 'placeholder'; ref: string | null };
export type Match = { id: string; round: number; position: number; notes?: string; description: string; slots: Slot[] };
export type Presentation = { title: string; slug: string; season: string; intro: string; description: string; accent: string; feature: string | null; cover: string | null };
export type Graph = { format: string; title: string; size: number; contenders: Contender[]; matches: Match[]; presentation: Presentation };
export type Decision = { id?: string; matchId: string; winnerId: string; source: string; scores: Array<number | null>; fingerprint?: string; reason?: string; linkId?: string };
export const FORMAT: string;
export function uid(prefix?: string): string;
export function generate(size?: number, title?: string): Graph;
export function validate(input: unknown): Graph;
export function duplicate(input: Graph): Graph;
export function safeGraph(input: Graph): Graph;
export function referenceTemplate(): { graph: Graph; historical: Decision[] };
export function opponents(graph: Graph, match: Match, decisions?: Decision[]): Array<Contender | null>;
export function descendants(graph: Graph, id: string): string[];

export function protectedMatchIds(graph: Graph, records?: Array<{ matchId: string }>): string[];
