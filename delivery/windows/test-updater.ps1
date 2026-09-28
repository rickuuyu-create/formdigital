param(
  [Parameter(Mandatory=$true)][string]$BuildEvidence,
  [Parameter(Mandatory=$true)][string]$BasePackage,
  [Parameter(Mandatory=$true)][string]$TestRoot
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $TestRoot) { throw 'TestRoot must be new.' }
$root = [IO.Path]::GetFullPath($TestRoot)
New-Item -ItemType Directory -Path $root | Out-Null
$copy = Join-Path $root 'Complete package'
New-Item -ItemType Directory -Path (Join-Path $copy 'app') -Force | Out-Null
# Copy only distributed program components, never an installed user's logs,
# config or Data folder. The runtime smoke test creates its own test data.
foreach($name in @('runtime','Form Digital.exe','首次使用說明.txt')) { Copy-Item -LiteralPath (Join-Path $BasePackage $name) -Destination $copy -Recurse }
foreach($name in @('dist','node_modules','scripts','server','local-data-service.mjs','package.json','package-lock.json')) {
  Copy-Item -LiteralPath (Join-Path $BasePackage ('app/' + $name)) -Destination (Join-Path $copy 'app') -Recurse
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$test = Join-Path $root 'UpdaterTests.exe'
$payload = Join-Path $BuildEvidence 'payload.zip'
$manifest = Join-Path $BuildEvidence 'update-manifest.json'
& $compiler /nologo /target:exe /main:FormDigitalUpdaterTests "/out:$test" /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$payload,payload.zip" "/resource:$manifest,update-manifest.json" (Join-Path $PSScriptRoot 'FormDigitalUpdateEngine.cs') (Join-Path $PSScriptRoot 'FormDigitalUpdater.cs') (Join-Path $PSScriptRoot 'FormDigitalUpdaterTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Updater tests did not compile.' }
& $test $BasePackage (Join-Path $root 'Fixtures') $copy
if ($LASTEXITCODE -ne 0) { throw 'Updater tests failed.' }
Write-Output "Updated isolated package: $copy"
