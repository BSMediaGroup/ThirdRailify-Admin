param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$repo = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { (Get-Location).Path }
if (-not (Test-Path -LiteralPath (Join-Path $repo 'commerce-migrations\0045_rumble_intelligence.sql'))) { throw 'Run from the Admin repository root' }
Set-Location -LiteralPath $repo
$env:PATH = 'C:\Users\TempAdmin\.codex\tmp\node-v22.16.0-win-x64;' + $env:PATH
$backup = 'X:\GIT\_BACKUPS\ThirdRailify\rumble-intelligence-20260909-before.sql'
$backupHash = '506D906D14BC3E1B11FD07FA3DC5A17E3123EBF6039C1F2D0A4DFE43C141AE84'
$migrationHash = '4ECC443CC730FF58A8DD1AAF3F0C1E1774E16980498AB9C5D0B1CC4A8F046EEF'
$file = Join-Path $repo 'commerce-migrations\0045_rumble_intelligence.sql'
if ((Get-Item -LiteralPath $backup).Length -ne 5179162 -or (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $backupHash) { throw 'Protected backup verification failed' }
if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $migrationHash) { throw 'Reviewed migration hash changed' }
$release = Join-Path $repo '.artifacts\rumble-intelligence\migration'
New-Item -ItemType Directory -Path (Join-Path $release 'approved') -Force | Out-Null
# Only the reviewed additive file is visible to Wrangler's supported ledger procedure.
$sql = [IO.File]::ReadAllText($file).Replace("`r`n", "`n")
[IO.File]::WriteAllText((Join-Path $release 'approved\0045_rumble_intelligence.sql'), $sql, [Text.UTF8Encoding]::new($false))
$configuration = @{ name='thirdrailify-admin'; compatibility_date='2026-08-11'; d1_databases=@(@{binding='THIRDRAILIFY_COMMERCE_DB';database_name='thirdrailify-commerce';database_id='3dd23a7e-7c64-49cb-a52c-c1540b41db1c';migrations_dir='./approved'}) }
$configPath = Join-Path $release 'wrangler.json'
[IO.File]::WriteAllText($configPath, ($configuration | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$ledger = & npm.cmd exec wrangler -- d1 execute thirdrailify-commerce --remote --config $configPath --command 'SELECT name FROM d1_migrations ORDER BY id' --json
if ($LASTEXITCODE -ne 0) { $ledger | Write-Output; throw 'Remote ledger read failed; no schema mutation attempted' }
$ledger | Set-Content -LiteralPath (Join-Path $release 'ledger-before.json')
$names = @((($ledger -join "`n") | ConvertFrom-Json)[0].results | ForEach-Object name)
$expected = @(Get-ChildItem -LiteralPath (Join-Path $repo 'commerce-migrations') -Filter '*.sql' | Where-Object Name -NE '0045_rumble_intelligence.sql' | ForEach-Object Name)
foreach ($name in $expected) { if ($name -notin $names) { throw "Unapplied prerequisite: $name" } }
if (-not $Apply) { Write-Output 'Preview verified: backup, migration hash and complete predecessor ledger. Pass -Apply to run only 0045.'; exit 0 }
& npm.cmd exec wrangler -- d1 migrations apply thirdrailify-commerce --remote --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; stop release' }
& npm.cmd exec wrangler -- d1 execute thirdrailify-commerce --remote --config $configPath --command "SELECT name,type FROM sqlite_master WHERE name LIKE 'rumble_intelligence_%'; PRAGMA foreign_key_check; SELECT name FROM d1_migrations WHERE name='0045_rumble_intelligence.sql';" --json
if ($LASTEXITCODE -ne 0) { throw 'Schema verification failed; stop release' }
