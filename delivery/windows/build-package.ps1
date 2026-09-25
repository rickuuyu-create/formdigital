param([string]$Destination)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Destination) { $Destination = Join-Path (Split-Path $project -Parent) 'Form Digital 交付包' }
$destinationFull = [IO.Path]::GetFullPath($Destination)
$projectFull = [IO.Path]::GetFullPath($project)
if ($destinationFull -eq $projectFull -or $destinationFull.StartsWith($projectFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The delivery package must be outside the project directory.'
}
if (Test-Path -LiteralPath $destinationFull) { throw "Destination already exists: $destinationFull" }
if (-not (Test-Path -LiteralPath (Join-Path $project 'client\index.html'))) { throw 'Website source is missing.' }
$node = (Get-Command node.exe).Source
if ((& $node -p 'process.versions.node.split(".")[0]') -ne '24') { throw 'Node 24 is required.' }
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler is unavailable.' }

$app = Join-Path $destinationFull 'app'
New-Item -ItemType Directory -Path $app, (Join-Path $destinationFull 'runtime'), (Join-Path $app 'scripts'), (Join-Path $app 'server\formdigital') -Force | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $destinationFull 'runtime\node.exe')
$nodeVersion = & $node -p 'process.versions.node'
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/v$nodeVersion/LICENSE" -OutFile (Join-Path $destinationFull 'runtime\NODE_LICENSE.txt') -TimeoutSec 30
$distRoot = Join-Path $app 'dist'
$env:VITE_FORMDIGITAL_LOCAL_ONLY = '1'
Push-Location $project
try {
  & (Join-Path $project 'node_modules\.bin\vite.cmd') build --outDir (Join-Path $distRoot 'public') --emptyOutDir
  if ($LASTEXITCODE -ne 0) { throw "Vite build failed: $LASTEXITCODE" }
  & (Join-Path $project 'node_modules\.bin\esbuild.cmd') 'server/_core/index.ts' --platform=node --packages=external --bundle --format=esm "--outdir=$distRoot"
  if ($LASTEXITCODE -ne 0) { throw "Server build failed: $LASTEXITCODE" }
} finally {
  Pop-Location
  Remove-Item Env:VITE_FORMDIGITAL_LOCAL_ONLY -ErrorAction SilentlyContinue
}
Copy-Item -LiteralPath (Join-Path $project 'local-data-service.mjs') -Destination $app
Copy-Item -LiteralPath (Join-Path $project 'scripts\start-production-runtime.mjs') -Destination (Join-Path $app 'scripts')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'initialize-delivery.mjs') -Destination (Join-Path $app 'scripts')
Copy-Item -LiteralPath (Join-Path $project 'server\formdigital\workspace-storage-v2.mjs') -Destination (Join-Path $app 'server\formdigital')
Copy-Item -LiteralPath (Join-Path $project 'server\formdigital\portable-archive-stream.mjs') -Destination (Join-Path $app 'server\formdigital')

$names = @('@pdf-lib/fontkit','@trpc/server','csv-parse','dotenv','express','fflate','jose','pdf-lib','pdfjs-dist','superjson','zod')
$deps = [ordered]@{}
foreach ($name in $names) {
  $manifestPath = Join-Path $project ("node_modules\$name\package.json")
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $deps[$name] = $manifest.version
}
$manifestOut = [ordered]@{ name = 'formdigital-windows-runtime'; version = '1.0.0'; private = $true; type = 'module'; dependencies = $deps }
$manifestOut | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding UTF8
Push-Location $app
try {
  & npm.cmd install --omit=dev --ignore-scripts --no-audit --no-fund --save-exact
  if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
} finally { Pop-Location }

$exe = Join-Path $destinationFull 'Form Digital.exe'
& $compiler /nologo /target:winexe "/out:$exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll (Join-Path $PSScriptRoot 'FormDigitalLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw "C# compiler failed: $LASTEXITCODE" }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '首次使用說明.txt') -Destination $destinationFull
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '首次使用说明.zh-Hans.txt') -Destination $destinationFull
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'First-use-guide.en.txt') -Destination $destinationFull
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.txt') -Destination $destinationFull
Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination $destinationFull
$critical = @('Form Digital.exe','LICENSE','runtime\node.exe','runtime\NODE_LICENSE.txt','app\dist\index.js','app\dist\public\index.html','app\package-lock.json')
$checksums = foreach ($relative in $critical) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $destinationFull $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $relative"
}
$checksums | Set-Content -LiteralPath (Join-Path $destinationFull 'SHA256SUMS.txt') -Encoding UTF8

$forbidden = Get-ChildItem -LiteralPath $destinationFull -File -Recurse -Force | Where-Object {
  $_.Name -match '^\.env' -or $_.Name -eq 'local-service-config.json' -or $_.Name -eq 'auth.env' -or $_.FullName -match 'FormdigitalData|\\\.git\\'
}
if ($forbidden) { throw 'Forbidden personal data or secret file found in package.' }
Write-Output "Package ready: $destinationFull"
