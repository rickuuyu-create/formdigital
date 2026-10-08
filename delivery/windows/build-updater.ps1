param(
  [Parameter(Mandatory=$true)][string]$BasePackage,
  [Parameter(Mandatory=$true)][string]$Destination,
  [string]$Version = '2026.09.30.1',
  [string[]]$PreviousPackages = @()
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[0-9]+(\.[0-9]+){2,3}$') { throw 'Use a numeric release version.' }
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$base = (Resolve-Path -LiteralPath $BasePackage).Path
$destinationFull = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationFull) { throw 'Choose a new output folder.' }
foreach ($protected in @($project,$base)) {
  if ($destinationFull -eq $protected -or $destinationFull.StartsWith($protected + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be outside the source and installed package.' }
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$work = Join-Path $project ('tmp\updater-build-' + [Guid]::NewGuid().ToString('N'))
$dist = Join-Path $work 'dist'
New-Item -ItemType Directory -Path $work | Out-Null
$previousLocalFlag = $env:VITE_FORMDIGITAL_LOCAL_ONLY
Push-Location $project
try {
  $env:VITE_FORMDIGITAL_LOCAL_ONLY = '1'
  & (Join-Path $project 'node_modules\.bin\vite.cmd') build --outDir (Join-Path $dist 'public')
  if ($LASTEXITCODE -ne 0) { throw 'Local-only frontend build failed.' }
  & node (Join-Path $project 'scripts\build-server.mjs') $dist --with-browser
  if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
  $revision = & git rev-parse HEAD
  $sourceModified = [bool](& git status --porcelain --untracked-files=normal)
} finally { $env:VITE_FORMDIGITAL_LOCAL_ONLY = $previousLocalFlag; Pop-Location }
[ordered]@{version=$Version; sourceRevision=$revision; sourceModified=$sourceModified; edition='local-offline'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dist 'formdigital-release.json') -Encoding utf8
$programPatch = Join-Path $dist 'program-patches'
New-Item -ItemType Directory -Path $programPatch | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'server/formdigital/portable-archive-stream.mjs') -Destination $programPatch
Copy-Item -LiteralPath (Join-Path $project 'local-data-service.mjs') -Destination $programPatch

# Exact compatibility fingerprint of code/runtime manifests only. Never read
# the user's config, data folder, logs, credentials or form assets.
$baseFiles = [ordered]@{}
$required = @('app/package.json','app/package-lock.json','app/scripts/initialize-delivery.mjs','app/scripts/start-production-runtime.mjs','app/local-data-service.mjs','app/server/formdigital/workspace-storage-v2.mjs','app/server/formdigital/portable-archive-stream.mjs')
foreach ($relative in $required) {
  $baseFiles[$relative] = (Get-FileHash -LiteralPath (Join-Path $base $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$deps = (Get-Content -LiteralPath (Join-Path $base 'app/package.json') -Raw | ConvertFrom-Json).dependencies
foreach ($dependency in $deps.PSObject.Properties) {
  $localVersion = (Get-Content -LiteralPath (Join-Path $project ('node_modules/' + $dependency.Name + '/package.json')) -Raw | ConvertFrom-Json).version
  if ($localVersion -ne $dependency.Value) { throw ('Runtime dependency changed: ' + $dependency.Name + '. Build a full package instead.') }
  $relative = 'app/node_modules/' + $dependency.Name + '/package.json'
  $baseFiles[$relative] = (Get-FileHash -LiteralPath (Join-Path $base $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$files = [ordered]@{}
foreach ($file in Get-ChildItem -LiteralPath $dist -File -Recurse) {
  $relative = $file.FullName.Substring($dist.Length + 1).Replace('\','/')
  $files[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$payload = Join-Path $work 'payload.zip'
$payloadArchive = [IO.Compression.ZipFile]::Open($payload, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem -LiteralPath $dist -File -Recurse) {
    $relative = $file.FullName.Substring($dist.Length + 1).Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($payloadArchive, $file.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $payloadArchive.Dispose() }
$manifest = Join-Path $work 'update-manifest.json'
$baseDist = Join-Path $base 'app/dist'
$baseDistFiles = @(Get-ChildItem -LiteralPath $baseDist -File -Recurse | ForEach-Object { $_.FullName.Substring($baseDist.Length + 1).Replace('\','/') })
foreach ($previousPackage in $PreviousPackages) {
  $previous = (Resolve-Path -LiteralPath $previousPackage).Path
  foreach ($relative in $baseFiles.Keys) {
    $previousHash = (Get-FileHash -LiteralPath (Join-Path $previous $relative)).Hash.ToLowerInvariant()
    # Match the installer's compatibility check: an earlier cumulative update
    # may already contain the exact service patches shipped in this payload.
    $patchRelative = switch ($relative) {
      'app/local-data-service.mjs' { 'program-patches/local-data-service.mjs' }
      'app/server/formdigital/portable-archive-stream.mjs' { 'program-patches/portable-archive-stream.mjs' }
      default { $null }
    }
    $alreadyPatched = $patchRelative -and $previousHash -eq $files[$patchRelative]
    if ($previousHash -ne $baseFiles[$relative] -and !$alreadyPatched) { throw 'Previous package is not from the same runtime family.' }
  }
  $previousDist = Join-Path $previous 'app/dist'
  $baseDistFiles += @(Get-ChildItem -LiteralPath $previousDist -File -Recurse | ForEach-Object { $_.FullName.Substring($previousDist.Length + 1).Replace('\','/') })
}
$baseDistFiles = @($baseDistFiles | Sort-Object -Unique)
[ordered]@{version=$Version; payloadSha256=(Get-FileHash -LiteralPath $payload).Hash.ToLowerInvariant(); files=$files; baseFiles=$baseFiles; baseDistFiles=$baseDistFiles; programFiles=@{'app/server/formdigital/portable-archive-stream.mjs'='program-patches/portable-archive-stream.mjs';'app/local-data-service.mjs'='program-patches/local-data-service.mjs'}} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding utf8
New-Item -ItemType Directory -Path $destinationFull | Out-Null
$exe = Join-Path $destinationFull ('Form Digital Update ' + $Version + '.exe')
$references = @('/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll')
& $compiler /nologo /target:winexe "/out:$exe" @references "/resource:$payload,payload.zip" "/resource:$manifest,update-manifest.json" (Join-Path $PSScriptRoot 'FormDigitalUpdateEngine.cs') (Join-Path $PSScriptRoot 'FormDigitalUpdater.cs')
if ($LASTEXITCODE -ne 0) { throw 'Updater compilation failed.' }
$hash = (Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant()
"$hash  $([IO.Path]::GetFileName($exe))" | Set-Content -LiteralPath (Join-Path $destinationFull 'SHA256SUMS.txt') -Encoding utf8
Write-Output "Updater: $exe"
Write-Output "Build evidence: $work"
