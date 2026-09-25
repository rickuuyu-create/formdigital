param([string]$Package)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Package) { $Package = Join-Path (Split-Path $project -Parent) 'Form Digital 交付包' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('FormDigitalPackageSmoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$env:FORMDIGITAL_LOCAL_CONFIG = Join-Path $testRoot 'config.json'
$env:FORMDIGITAL_DATA_FOLDER = Join-Path $testRoot 'Data'
$env:FORMDIGITAL_LDS_HEALTH_PORT = '43214'
$env:FORMDIGITAL_WEB_PORT = '32124'
$env:FORMDIGITAL_NO_BROWSER = '1'
$process = $null
try {
  $process = Start-Process -FilePath (Join-Path $Package 'Form Digital.exe') -PassThru -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 100; $i++) {
    if ($process.HasExited) { throw 'Desktop launcher exited before the site was ready.' }
    try {
      $preflight = Invoke-RestMethod 'http://127.0.0.1:32124/api/local/preflight' -TimeoutSec 2
      if ($preflight.status -eq 'ok') { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 300
  }
  if (-not $ready) { throw 'Website preflight never became ready.' }
  $root = Invoke-WebRequest 'http://127.0.0.1:32124/' -TimeoutSec 5
  if ($root.StatusCode -ne 200 -or $root.Content -notmatch '<html') { throw 'Website root is not valid HTML.' }
  $ocr = Invoke-WebRequest 'http://127.0.0.1:32124/ocr-runtime/worker.min.js' -TimeoutSec 5
  if ($ocr.StatusCode -ne 200 -or $ocr.Content.Length -lt 1000) { throw 'Bundled OCR worker is missing.' }
  $pdfjs = Invoke-WebRequest 'http://127.0.0.1:32124/pdfjs/cmaps/78-H.bcmap' -TimeoutSec 5
  if ($pdfjs.StatusCode -ne 200) { throw 'PDF.js assets are missing.' }
  if (-not (Test-Path -LiteralPath $env:FORMDIGITAL_LOCAL_CONFIG)) { throw 'Local config was not created.' }
  if (Test-Path -LiteralPath (Join-Path $testRoot 'auth.env')) { throw 'Local edition created unnecessary login credentials.' }
  $config = Get-Content -LiteralPath $env:FORMDIGITAL_LOCAL_CONFIG -Raw | ConvertFrom-Json
  if ($config.dataFolder -ne $env:FORMDIGITAL_DATA_FOLDER -or $config.port -ne 43214 -or $config.token.Length -lt 32) { throw 'Local config is invalid.' }
  $before = (Get-FileHash -LiteralPath $env:FORMDIGITAL_LOCAL_CONFIG -Algorithm SHA256).Hash
  & (Join-Path $Package 'runtime\node.exe') (Join-Path $Package 'app\scripts\initialize-delivery.mjs') | Out-Null
  if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $env:FORMDIGITAL_LOCAL_CONFIG -Algorithm SHA256).Hash -ne $before) { throw 'Existing local config was changed by setup.' }
  $me = Invoke-WebRequest 'http://127.0.0.1:32124/api/trpc/auth.me' -TimeoutSec 5
  if ($me.StatusCode -ne 200 -or $me.Content -notmatch 'local-owner' -or $me.Content -notmatch 'local') { throw 'No-login local owner is unavailable.' }
  $google = Invoke-WebRequest 'http://127.0.0.1:32124/api/auth/google/start' -TimeoutSec 5 -SkipHttpErrorCheck
  if ($google.StatusCode -ne 404) { throw 'Google login route remains enabled.' }
  $crossSite = Invoke-WebRequest 'http://127.0.0.1:32124/api/trpc/auth.me' -Headers @{ Origin = 'http://evil.example' } -TimeoutSec 5 -SkipHttpErrorCheck
  if ($crossSite.StatusCode -ne 403) { throw 'Cross-site request was accepted.' }
  if ($root.Headers['Content-Security-Policy'] -notmatch 'connect-src') { throw 'Local-only CSP is missing.' }
  $bound = @(Get-NetTCPConnection -LocalPort 32124, 43214 -State Listen -ErrorAction SilentlyContinue)
  if ($bound.Count -ne 2 -or @($bound | Where-Object LocalAddress -ne '127.0.0.1').Count -ne 0) { throw 'Services are not loopback-only.' }
  Write-Output 'EXE, Local Data Service, website, OCR and PDF.js: PASS'
} finally {
  if ($process -and -not $process.HasExited) {
    # The automated run hides the window, so it has no interactive close button.
    # Terminating this one owned launcher also verifies the Windows Job cleans its children.
    $process.Kill()
    if (-not $process.WaitForExit(10000)) { throw 'Launcher did not terminate.' }
  }
  Remove-Item Env:FORMDIGITAL_LOCAL_CONFIG, Env:FORMDIGITAL_DATA_FOLDER, Env:FORMDIGITAL_LDS_HEALTH_PORT, Env:FORMDIGITAL_WEB_PORT, Env:FORMDIGITAL_NO_BROWSER -ErrorAction SilentlyContinue
}
$listeners = @()
for ($i = 0; $i -lt 20; $i++) {
  $listeners = @(Get-NetTCPConnection -LocalPort 32124, 43214 -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}
if ($listeners.Count -ne 0) { throw 'Services remained active after launcher exit.' }
Write-Output 'Launcher termination and child cleanup: PASS'
Write-Output "Isolated smoke data: $testRoot"
