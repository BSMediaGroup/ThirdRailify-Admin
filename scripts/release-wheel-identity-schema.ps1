param([Parameter(Mandatory=$true)][string]$BackupPath, [Parameter(Mandatory=$true)][string]$BackupSha256, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$migrationName = '0050_wheel_entrant_codes_activity_and_successions.sql'
$migration = Join-Path $repo "commerce-migrations\$migrationName"
$node = 'C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64\node.exe'
$wrangler = Join-Path $repo 'node_modules\wrangler\bin\wrangler.js'
if (-not (Test-Path -LiteralPath $BackupPath)) { throw 'Protected backup is missing.' }
if ((Get-FileHash -LiteralPath $BackupPath -Algorithm SHA256).Hash -ne $BackupSha256.ToUpperInvariant()) { throw 'Protected backup hash does not match.' }
Set-Location -LiteralPath $repo

$release = Join-Path $repo '.artifacts\wheel-identity-release\migration'; $approved = Join-Path $release 'approved'
New-Item -ItemType Directory -Path $approved -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $approved $migrationName), [IO.File]::ReadAllText($migration).Replace("`r`n","`n"), [Text.UTF8Encoding]::new($false))
$configuration = @{ name='thirdrailify-admin'; compatibility_date='2026-08-11'; d1_databases=@(@{binding='THIRDRAILIFY_COMMERCE_DB';database_name='thirdrailify-commerce';database_id='3dd23a7e-7c64-49cb-a52c-c1540b41db1c';migrations_dir='./approved'}) }
$configPath = Join-Path $release 'wrangler.json'; [IO.File]::WriteAllText($configPath,($configuration|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$ledgerRaw = & $node $wrangler d1 execute thirdrailify-commerce --remote --config $configPath --command 'SELECT name FROM d1_migrations ORDER BY id' --json
if ($LASTEXITCODE -ne 0) { throw 'Remote ledger read failed; no mutation attempted.' }
$names = @((($ledgerRaw -join "`n")|ConvertFrom-Json)[0].results|ForEach-Object name)
foreach ($required in @('0042_wheel_entrant_identity.sql','0048_subscriber_roster_automation.sql','0049_rumble_intelligence_rollups.sql')) { if ($required -notin $names) { throw "Unapplied prerequisite: $required" } }
if ('0046_poll_permanent_delete.sql' -in $names) { throw 'Unrelated 0046 is unexpectedly applied; stop and inspect.' }
if ($migrationName -in $names) { throw "$migrationName is already applied." }
if (-not $Apply) { Write-Output "Preview verified: backup hash, prerequisites, unrelated 0046 exclusion, and isolated $migrationName."; exit 0 }
& $node $wrangler d1 migrations apply thirdrailify-commerce --remote --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; stop release.' }
& $node $wrangler d1 execute thirdrailify-commerce --remote --config $configPath --command "SELECT name FROM d1_migrations WHERE name='$migrationName'; SELECT name,type FROM sqlite_master WHERE name IN ('wheel_entry_source_bindings','automation_receipt_details','wheel_successions','wheel_entries_entrant_code_unique'); PRAGMA foreign_key_check;" --json
if ($LASTEXITCODE -ne 0) { throw 'Schema verification failed; stop release.' }
Write-Output 'Migration 0050 applied in isolation. Run backfill-wheel-entrant-codes.ps1 -Apply before deployment acceptance.'
