export const PLATFORM_OPTIONS = ["PC via Steam", "PC", "SNES", "Nintendo Switch", "PlayStation", "PlayStation 2", "PlayStation 3", "PlayStation 4", "PlayStation 5", "Xbox", "Xbox 360", "Xbox One", "Xbox Series X/S", "Mac", "Linux"];
export function normalizePlatform(name: string): string {
  const value = name.trim();
  if (/\b(snes|super nintendo|super famicom)\b/i.test(value)) return "SNES";
  if (/\bnintendo switch\b/i.test(value)) return "Nintendo Switch";
  if (/\b(pc|windows)\b/i.test(value)) return "PC";
  const ps = value.match(/\b(?:playstation\s*|ps)([1-5])?\b/i);
  if (ps) return ps[1] && ps[1] !== "1" ? `PlayStation ${ps[1]}` : "PlayStation";
  if (/\b(mac|macintosh|macos)\b/i.test(value)) return "Mac";
  if (/\blinux\b/i.test(value)) return "Linux";
  return value;
}
export function providerPlatforms(names: string[]): string[] {
  return [...new Set(names.map(normalizePlatform).filter(Boolean))];
}
