param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$repo = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { (Get-Location).Path }
$migrationName = '0048_subscriber_roster_automation.sql'
$migration = Join-Path $repo "commerce-migrations\$migrationName"
if (-not (Test-Path -LiteralPath $migration)) { throw 'Run from the Admin repository root' }

Set-Location -LiteralPath $repo
$node = 'C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64\node.exe'
$wrangler = Join-Path $repo 'node_modules\wrangler\bin\wrangler.js'
$backup = 'X:\GIT\_BACKUPS\ThirdRailify\subscriber-roster-20260912-143839\commerce-before.sql'
$backupBytes = 6345807
$backupHash = '59A0AE9C2FA7C164F9BC5B4AD4DA1349C77933E4C9F88BC10739873601FE0A0E'
$migrationHash = '7C8F1D06FB670FD3FF43BCB21B4C5096558D4EEA42AEC1E8416117D1E37ED699'

if ((Get-Item -LiteralPath $backup).Length -ne $backupBytes -or (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $backupHash) { throw 'Protected backup verification failed' }
if ((Get-FileHash -LiteralPath $migration -Algorithm SHA256).Hash -ne $migrationHash) { throw 'Reviewed migration hash changed' }

$release = Join-Path $repo '.artifacts\subscriber-roster\migration'
$approved = Join-Path $release 'approved'
New-Item -ItemType Directory -Path $approved -Force | Out-Null
$sql = [IO.File]::ReadAllText($migration).Replace("`r`n", "`n")
[IO.File]::WriteAllText((Join-Path $approved $migrationName), $sql, [Text.UTF8Encoding]::new($false))
$configuration = @{ name='thirdrailify-admin'; compatibility_date='2026-08-11'; d1_databases=@(@{binding='THIRDRAILIFY_COMMERCE_DB';database_name='thirdrailify-commerce';database_id='3dd23a7e-7c64-49cb-a52c-c1540b41db1c';migrations_dir='./approved'}) }
$configPath = Join-Path $release 'wrangler.json'
[IO.File]::WriteAllText($configPath, ($configuration | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

$ledgerJson = & $node $wrangler d1 execute thirdrailify-commerce --remote --config $configPath --command 'SELECT name FROM d1_migrations ORDER BY id' --json
if ($LASTEXITCODE -ne 0) { $ledgerJson | Write-Output; throw 'Remote ledger read failed; no schema mutation attempted' }
$ledgerJson | Set-Content -LiteralPath (Join-Path $release 'ledger-before.json')
$names = @((($ledgerJson -join "`n") | ConvertFrom-Json)[0].results | ForEach-Object name)
$expected = @(Get-ChildItem -LiteralPath (Join-Path $repo 'commerce-migrations') -Filter '*.sql' | Where-Object Name -NotIn @('0046_poll_permanent_delete.sql', $migrationName) | ForEach-Object Name)
foreach ($name in $expected) { if ($name -notin $names) { throw "Unapplied prerequisite: $name" } }
if ('0046_poll_permanent_delete.sql' -in $names) { throw 'Unrelated 0046 is unexpectedly applied; stop and inspect' }
if ($migrationName -in $names) { throw "$migrationName is already applied" }
if (-not $Apply) { Write-Output "Preview verified: backup, migration hash, predecessor ledger, and isolated $migrationName. Pass -Apply to apply only it."; exit 0 }

& $node $wrangler d1 migrations apply thirdrailify-commerce --remote --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; stop release' }
& $node $wrangler d1 execute thirdrailify-commerce --remote --config $configPath --command "SELECT name,type FROM sqlite_master WHERE name LIKE 'subscriber_roster_%' OR name LIKE 'wheel_entry_contributions%'; PRAGMA foreign_key_check; SELECT name FROM d1_migrations WHERE name='$migrationName';" --json
if ($LASTEXITCODE -ne 0) { throw 'Schema verification failed; stop release' }
