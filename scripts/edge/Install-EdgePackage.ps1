<#
  PSA Edge appliance on a Windows machine WITHOUT Docker Desktop (Docker Engine inside WSL).
  Installs a deployment package ZIP downloaded from the PSA Control Center dashboard, runs the
  package's own Linux install and verify scripts inside WSL, and prints the local admin URL.

  Usage (PowerShell; from Command Prompt use scripts\edge\psa-edge.cmd):
    .\Install-EdgePackage.ps1 -Zip "$env:USERPROFILE\Downloads\psacc-dep-00030-package-1.zip"
    .\Install-EdgePackage.ps1 -Status DEP-00030        # containers, agent state, verification checks
    .\Install-EdgePackage.ps1 -Stop   DEP-00030        # stop, keep data
    .\Install-EdgePackage.ps1 -Wipe   DEP-00030        # remove everything (asks to type the ID)

  The appliance lives in WSL under /opt/psa-edge/<project>; nothing is installed on Windows itself.
  Requires: WSL with Docker Engine (docker compose v2) — the same engine the development stack uses.
  Exit code 0 only when the package's verification passes.
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory)] [string]$Zip,
  [Parameter(ParameterSetName = 'Status', Mandatory)] [string]$Status,
  [Parameter(ParameterSetName = 'Stop', Mandatory)] [string]$Stop,
  [Parameter(ParameterSetName = 'Wipe', Mandatory)] [string]$Wipe,
  [switch]$Production,
  [string]$Distro = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Stop-WithError([string]$m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
$wslArgs = @(); if ($Distro) { $wslArgs = @('-d', $Distro) }
# Runs a command in WSL as root. The script text crosses the Windows/Linux boundary base64-encoded, so no
# command-line quoting or line-ending issue can alter it (identical behaviour in Windows PowerShell 5.1
# and PowerShell 7). Output streams to the console; the return value is ONLY the exit code.
function ConvertTo-WslArgument([string]$Command) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
  # Decoded into a temporary file and run from there, so commands inside (docker compose exec, apt-get)
  # never swallow the script from standard input. Single quotes: nothing here is expanded by PowerShell.
  return 'f=$(mktemp); echo ' + $b64 + ' | base64 -d > $f; bash $f; rc=$?; rm -f $f; exit $rc'
}
function Invoke-Wsl([string]$Command) {
  & wsl.exe @wslArgs -u root --exec bash -c (ConvertTo-WslArgument $Command) | Out-Host
  return [int]$LASTEXITCODE
}
# Same, but returns the output as one string (for values, not for display).
function Get-WslOutput([string]$Command) {
  $lines = & wsl.exe @wslArgs -u root --exec bash -c (ConvertTo-WslArgument $Command)
  return (@($lines) -join "`n").Trim()
}
function Get-ProjectName([string]$Code) {
  if ($Code -notmatch '^(?i)dep-\d{5}$') { Stop-WithError "Give the deployment ID, for example DEP-00030 (got '$Code')." }
  return "psacc-$($Code.ToLower())"
}
function Test-Installed([string]$Dir, [string]$Project) {
  if ((Invoke-Wsl "test -d '$Dir'") -ne 0) { Stop-WithError "$Project is not installed on this machine (no $Dir in WSL)." }
}

Write-Step 'Checking Docker Engine inside WSL'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Stop-WithError 'WSL is not installed on this machine.' }
$engine = Get-WslOutput 'docker version --format "{{.Server.Version}}" 2>/dev/null && docker compose version --short 2>/dev/null'
if (-not $engine) { Stop-WithError 'Docker Engine is not running inside WSL (start it, e.g. `wsl -u root service docker start`).' }
Write-Host "  Docker $($engine -replace "`n", ', compose ')"
$base = '/opt/psa-edge'

switch ($PSCmdlet.ParameterSetName) {
  'Install' {
    if (-not (Test-Path -LiteralPath $Zip)) { Stop-WithError "ZIP not found: $Zip" }
    $zipFull = (Resolve-Path -LiteralPath $Zip).Path
    $zipWsl = Get-WslOutput "wslpath -a '$($zipFull -replace '\\', '/')'"
    if ((Invoke-Wsl 'command -v unzip >/dev/null 2>&1 || (apt-get update -q >/dev/null && apt-get install -y -q unzip >/dev/null)') -ne 0) { Stop-WithError 'unzip could not be installed in WSL.' }
    $project = Get-WslOutput "unzip -Z1 '$zipWsl' | head -n 1 | cut -d/ -f1"
    if ($project -notmatch '^psacc-dep-\d{5}$') { Stop-WithError "This does not look like a PSA Edge package (top folder '$project')." }
    $code = $project.Substring(6).ToUpper()
    $dir = "$base/$project"

    Write-Step "Unpacking $project into WSL ($dir)"
    $existing = (Invoke-Wsl "test -d '$dir/secrets'") -eq 0
    if ($existing) { Write-Host "  An installation of $project already exists: its secrets, data and .env are kept; the package files are refreshed." }
    $unpack = "set -e; mkdir -p '$base'; cd '$base'; rm -rf '$project.new'; mkdir '$project.new'; unzip -q '$zipWsl' -d '$project.new'; " +
              "if [ -d '$dir' ]; then cp -a '$dir/secrets' '$project.new/$project/' 2>/dev/null || true; cp -a '$dir/.env' '$project.new/$project/' 2>/dev/null || true; rm -rf '$dir'; fi; " +
              "mv '$project.new/$project' '$dir'; rm -rf '$project.new'; cd '$dir'; sha256sum -c CHECKSUMS.sha256 --quiet; chmod +x scripts/*.sh"
    if ((Invoke-Wsl $unpack) -ne 0) { Stop-WithError 'Unpacking or checksum verification failed (see above).' }

    Write-Step 'Local settings (.env)'
    if ((Invoke-Wsl "cd '$dir' && (test -f .env || cp config/edge.env.template .env)") -ne 0) { Stop-WithError '.env could not be prepared.' }
    $image = Get-WslOutput "sed -n 's/^# PSA_EDGE_IMAGE=//p' '$dir/config/edge.env.template' | head -n 1"
    Write-Host "  appliance image: $(if ($image) { $image } else { '(see compose.yaml)' })"

    Write-Step "Installing — the package's own scripts/install.sh, inside WSL"
    $flag = if ($Production) { ' --production' } else { '' }
    $installExit = Invoke-Wsl "cd '$dir' && scripts/install.sh$flag"

    Write-Step "Verifying — the package's own scripts/verify.sh"
    $verifyExit = Invoke-Wsl "cd '$dir' && scripts/verify.sh"
    if ($verifyExit -ne 0) {
      Stop-WithError "Verification failed (install.sh exit $installExit, verify.sh exit $verifyExit). Logs: wsl -u root bash -c 'cd $dir && docker compose -f compose.yaml logs --tail 50'"
    }
    if ($installExit -ne 0) { Write-Host "  note: install.sh exited with $installExit, but every verification check passes; the appliance is running." -ForegroundColor Yellow }
    $port = Get-WslOutput "sed -n 's/^EDGE_LOCAL_ADMIN_PORT=//p' '$dir/.env' | head -n 1"
    Write-Host ''
    Write-Host "Installed and verified: $project" -ForegroundColor Green
    Write-Host "  Local admin UI:  http://localhost:$port   (first visit: create the local administrator, then enter the PSA credentials)"
    Write-Host "  Dashboard:       the deployment shows Enrolled within a minute and Verified after the first health reports."
    Write-Host "  Later:           .\Install-EdgePackage.ps1 -Status $code   |   psa-edge.cmd status $code"
    exit 0
  }
  'Status' {
    $project = Get-ProjectName $Status; $dir = "$base/$project"; Test-Installed $dir $project
    Write-Step "$project containers"
    [void](Invoke-Wsl "cd '$dir' && docker compose -f compose.yaml ps --format 'table {{ .Service }}\t{{ .State }}\t{{ .Status }}'")
    Write-Step 'Agent'
    # The agent's status JSON reduced to a few plain lines (quotes stripped first, so none are needed here).
    [void](Invoke-Wsl "cd '$dir' && (docker compose -f compose.yaml exec -T edge-agent edge-agent status 2>/dev/null | tr -d '{}`"' | grep -E '^ *(state|enrolled|lastHeartbeatAt|lastError):' | sed 's/^ *//; s/,$//; s/^/  /') || echo '  (agent not running)'")
    Write-Step 'Verification'
    $verifyExit = Invoke-Wsl "cd '$dir' && scripts/verify.sh"
    $port = Get-WslOutput "sed -n 's/^EDGE_LOCAL_ADMIN_PORT=//p' '$dir/.env' | head -n 1"
    Write-Host ''
    Write-Host "  Local admin UI: http://localhost:$port"
    exit $verifyExit
  }
  'Stop' {
    $project = Get-ProjectName $Stop; $dir = "$base/$project"; Test-Installed $dir $project
    Write-Step "Stopping $project (data, secrets and .env are kept; install the package again to resume)"
    exit (Invoke-Wsl "cd '$dir' && scripts/uninstall.sh")
  }
  'Wipe' {
    $project = Get-ProjectName $Wipe; $dir = "$base/$project"; Test-Installed $dir $project
    $code = $Wipe.ToUpper()
    Write-Host "This deletes the appliance's database, logs, backups, agent state and secrets on this machine." -ForegroundColor Yellow
    $typed = Read-Host "Type $code to confirm"
    if ($typed -ne $code) { Stop-WithError 'Not confirmed.' }
    Write-Step "Wiping $project"
    if ((Invoke-Wsl "cd '$dir' && scripts/uninstall.sh --wipe --confirm $code --force") -ne 0) { Stop-WithError 'Wipe failed; see the output above.' }
    [void](Invoke-Wsl "rm -rf '$dir'")
    Write-Host "Removed $project from this machine. Decommission or remove the deployment in the dashboard as well." -ForegroundColor Green
    exit 0
  }
}
