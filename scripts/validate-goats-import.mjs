import { readFile } from "node:fs/promises";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run goats:import:dry-run -- path/to/wix-goats-export.json");
  process.exitCode = 2;
} else {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(input)) throw new Error("The import root must be a JSON array.");
  const slugs = new Set();
  const errors = [];
  input.forEach((row, index) => {
    const at = `record ${index + 1}`;
    if (!row || typeof row !== "object") { errors.push(`${at}: object required`); return; }
    if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(String(row.slug || ""))) errors.push(`${at}: valid canonical slug required`);
    if (slugs.has(row.slug)) errors.push(`${at}: duplicate slug ${row.slug}`); else slugs.add(row.slug);
    if (!String(row.displayName || "").trim()) errors.push(`${at}: displayName required`);
    if (!String(row.description || "").trim()) errors.push(`${at}: public description required`);
    if (!String(row.productId || "").trim()) errors.push(`${at}: authoritative productId required`);
    if (!String(row.city || "").trim()) errors.push(`${at}: public city required`);
    if (!/^[A-Z]{2}$/.test(String(row.countryCode || ""))) errors.push(`${at}: ISO countryCode required`);
    if (row.rating != null && (!Number.isInteger(row.rating) || row.rating < 1 || row.rating > 5)) errors.push(`${at}: rating must be null or integer 1-5`);
    if (!row.publishedAt || Number.isNaN(new Date(row.publishedAt).getTime())) errors.push(`${at}: valid public publishedAt required`);
    if ("email" in row || "exactLatitude" in row || "exactLongitude" in row || "reactionCount" in row) errors.push(`${at}: private or fabricated engagement fields are forbidden`);
    if (!Array.isArray(row.media) || row.media.length < 1 || row.media.length > 7) errors.push(`${at}: media must contain 1-7 owner-exported public items`);
    else {
      const roles = row.media.map((media) => String(media?.role || ""));
      if (roles.filter((role) => role === "main").length !== 1 || roles.filter((role) => role === "profile").length > 1 || roles.filter((role) => role === "gallery").length > 5 || roles.some((role) => !new Set(["main", "profile", "gallery"]).has(role))) errors.push(`${at}: media roles require one main, up to one profile, and up to five gallery items`);
      if (row.media.some((media) => !String(media?.sourceFile || "").trim())) errors.push(`${at}: each media item requires an owner-exported sourceFile`);
    }
  });
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`GOATS import dry-run valid: ${input.length} records; no database or object-storage writes performed.`);
}
