# Starts Slidr Studio (README.md).
#
#   ./start.ps1               the studio at http://127.0.0.1:8765, opened in the browser
#   ./start.ps1 -Port 9000
#   ./start.ps1 -NoOpen
#
# The first run makes the Python environment (server/.venv) and installs the server's packages.
# The pages are built again whenever a source file is newer than the build.
param(
  [int]$Port = 8765,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repo = $here
$server = Join-Path $here 'server'
$python = Join-Path $server '.venv\Scripts\python.exe'

function Find-Python {
  # The Microsoft Store's python.exe is a stub that opens the Store: a candidate counts only when
  # it runs and is 3.11 or newer.
  $candidates = @()
  $launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($launcher) { $candidates += , @($launcher.Source, '-3') }
  Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | ForEach-Object { $candidates += , @($_.FullName) }
  $onPath = Get-Command python -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += , @($onPath.Source) }
  foreach ($candidate in $candidates) {
    $exe = $candidate[0]
    $rest = @($candidate | Select-Object -Skip 1)
    try {
      $ok = & $exe @rest -c 'import sys; print(sys.version_info >= (3, 11))' 2>$null
      if ($ok -eq 'True') { return , $candidate }
    } catch { }
  }
  throw 'Python 3.11 or newer was not found. Install it (winget install Python.Python.3.13) and run this again.'
}

if (-not (Test-Path $python)) {
  $base = Find-Python
  $exe = $base[0]
  $rest = @($base | Select-Object -Skip 1)
  Write-Host "Making the Python environment in $server\.venv"
  & $exe @rest -m venv (Join-Path $server '.venv')
  & $python -m pip install --quiet --upgrade pip
  & $python -m pip install --quiet -r (Join-Path $server 'requirements.txt')
}

$web = Join-Path $here 'web'
$built = Join-Path $web 'dist\index.html'
$sources = Get-ChildItem (Join-Path $web 'src'), (Join-Path $web 'index.html'), (Join-Path $web 'render.html') -Recurse -File
$newest = ($sources | Measure-Object -Property LastWriteTime -Maximum).Maximum
if (-not (Test-Path $built) -or (Get-Item $built).LastWriteTime -lt $newest) {
  Write-Host 'Building the pages'
  Push-Location $repo
  try {
    if (-not (Test-Path (Join-Path $web 'node_modules'))) { pnpm install }
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'The pages did not build.' }
  } finally {
    Pop-Location
  }
}

Push-Location $server
try {
  $arguments = @('-m', 'slidr_manager', '--port', $Port)
  if ($NoOpen) { $arguments += '--no-open' }
  & $python @arguments
} finally {
  Pop-Location
}
