param([switch]$Apply, [int]$BatchSize = 100)

$ErrorActionPreference = 'Stop'
if ($BatchSize -lt 1 -or $BatchSize -gt 100) { throw 'BatchSize must be between 1 and 100.' }
$repo = Split-Path $PSScriptRoot -Parent
$node = 'C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64\node.exe'
$wrangler = Join-Path $repo 'node_modules\wrangler\bin\wrangler.js'
$alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
Set-Location -LiteralPath $repo

function Invoke-D1Json([string]$Sql) {
  $raw = & $node $wrangler d1 execute thirdrailify-commerce --remote --command $Sql --json
  if ($LASTEXITCODE -ne 0) { $raw | Write-Output; throw 'Remote D1 command failed.' }
  return (($raw -join "`n") | ConvertFrom-Json)[0]
}
function New-EntrantCode {
  $bytes = [byte[]]::new(7)
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return -join ($bytes | ForEach-Object { $alphabet[$_ -band 31] })
}

$ready = Invoke-D1Json "SELECT COUNT(*) AS ready FROM d1_migrations WHERE name='0050_wheel_entrant_codes_activity_and_successions.sql'"
if ([int]$ready.results[0].ready -ne 1) { throw 'Migration 0050 must be applied before code backfill.' }
$before = Invoke-D1Json 'SELECT COUNT(*) AS pending FROM wheel_entries WHERE entrant_code IS NULL'
$pending = [int]$before.results[0].pending
if (-not $Apply) { Write-Output "Preview: $pending Wheel entrants require codes. Pass -Apply to process at most $BatchSize rows per transaction until complete."; exit 0 }

$updated = 0
while ($true) {
  $page = Invoke-D1Json "SELECT id FROM wheel_entries WHERE entrant_code IS NULL ORDER BY created_at,id LIMIT $BatchSize"
  $ids = @($page.results | ForEach-Object id)
  if (-not $ids.Count) { break }
  $used = [Collections.Generic.HashSet[string]]::new()
  $statements = foreach ($id in $ids) {
    do { $code = New-EntrantCode } while (-not $used.Add($code))
    $safeId = ([string]$id).Replace("'", "''")
    "UPDATE wheel_entries SET entrant_code='$code',updated_at=updated_at WHERE id='$safeId' AND entrant_code IS NULL AND NOT EXISTS(SELECT 1 FROM wheel_entries WHERE entrant_code='$code')"
  }
  [void](Invoke-D1Json (($statements -join ";`n") + ';'))
  $remainingResult = Invoke-D1Json 'SELECT COUNT(*) AS pending FROM wheel_entries WHERE entrant_code IS NULL'
  $remaining = [int]$remainingResult.results[0].pending
  if ($remaining -ge $pending) { throw 'Backfill made no progress; safe to rerun after inspection.' }
  $updated += $pending - $remaining; $pending = $remaining
  Write-Output "Entrant codes: $updated updated, $pending remaining."
}
$verification = Invoke-D1Json "SELECT SUM(CASE WHEN entrant_code IS NULL THEN 1 ELSE 0 END) AS missing,COUNT(*)-COUNT(DISTINCT entrant_code) AS duplicate_count,SUM(CASE WHEN length(entrant_code)!=7 OR entrant_code GLOB '*[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]*' THEN 1 ELSE 0 END) AS invalid FROM wheel_entries"
if ([int]$verification.results[0].missing -ne 0 -or [int]$verification.results[0].duplicate_count -ne 0 -or [int]$verification.results[0].invalid -ne 0) { throw 'Entrant-code verification failed.' }
Write-Output "Backfill complete: $updated entrants assigned unique seven-character codes."
