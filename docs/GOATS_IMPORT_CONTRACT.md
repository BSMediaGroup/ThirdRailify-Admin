# GOATS Wix export import contract

The owner will supply the existing approved Wix listing export in a later phase. No Wix listing is automatically scraped or shipped by V2.

Use a JSON array. Each record must contain a stable `slug`, public `displayName`, public `description`, authoritative V2 `productId`, `city`, optional `region`, ISO-3166 alpha-2 `countryCode`, optional integer `rating` from 1 through 5, original public publication date, and 1–7 owner-exported public media records. Media records must identify the main/profile/gallery role and the source file supplied for controlled R2 migration.

Do not include private email, user IDs, exact addresses, precise coordinates, Wix authentication fields, or copied engagement counts. Approximate public coordinates are confirmed in Admin before approval. Media must be uploaded through the safe image pipeline; runtime Wix image URLs are not accepted as the final storage path.

Dry-run only:

```powershell
npm run goats:import:dry-run -- C:\path\to\wix-goats-export.json
```

The validator performs no D1, R2, Wix, provider, or network mutation. An idempotent writer will be added only when the real export shape is available.
