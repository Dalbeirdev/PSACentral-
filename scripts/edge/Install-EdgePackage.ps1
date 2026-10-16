<#
  PSA Edge appliance on a Windows machine WITHOUT Docker Desktop (Docker Engine inside WSL).
  Installs a deployment package ZIP downloaded from the PSA Control Center dashboard, runs the
  package's own Linux install and verify scripts inside WSL, and prints the local admin URL.

  Usage (PowerShell):
    .\Install-EdgePackage.ps1 -Zip "$env:USERPROFILE\Downloads\psacc-dep-00030-package-1.zip"
    .\Install-EdgePackage.ps1 -Status    DEP-00030        # containers, health, agent state
    .\Install-EdgePackage.ps1 -Stop      DEP-00030        # stop, keep data
    .\Install-EdgePackage.ps1 -Wipe      DEP-00030        # remove everything (asks to type the ID)

  The appliance lives in WSL under /opt/psa-edge/<project>; nothing is installed on Windows itself.
  Requires: WSL with Docker Engine (docker compose v2) — the same engine the development stack uses.
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
function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
$wslArgs = @(); if ($Distro) { $wslArgs += @('-d', $Distro) }
function Invoke-Wsl([string]$cmd) { & wsl.exe @wslArgs -u root --exec bash -c $cmd; return $LASTEXITCODE }
function Show-Wsl([string]$cmd) { & wsl.exe @wslArgs -u root --exec bash -c $cmd | Out-Host }
function Get-WslOutput([string]$cmd) { (& wsl.exe @wslArgs -u root --exec bash -c $cmd) -join "`n" }
function ProjectOf([string]$code) { if ($code -notmatch '^(?i)dep-\d{5}$') { Fail "Give the deployment ID, e.g. DEP-00030." }; return "psacc-$($code.ToLower())" }

Step 'Checking Docker Engine inside WSL'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Fail 'WSL is not installed on this machine.' }
$ver = Get-WslOutput 'docker version --format "{{.Server.Version}}" 2>/dev/null && docker compose version --short 2>/dev/null'
if (-not $ver) { Fail 'Docker Engine is not running inside WSL (start it, e.g. `wsl -u root service docker start`).' }
Write-Host "  Docker $($ver -replace "`n", ', compose ')"

switch ($PSCmdlet.ParameterSetName) {
  'Install' {
    if (-not (Test-Path $Zip)) { Fail "ZIP not found: $Zip" }
    $zipFull = (Resolve-Path $Zip).Path
    $zipWsl = Get-WslOutput "wslpath -a '$($zipFull -replace '\\', '/')'"
    $project = Get-WslOutput "unzip -Z1 '$zipWsl' | head -n 1 | cut -d/ -f1"
    if ($project -notmatch '^psacc-dep-\d{5}$') { Fail "This does not look like a PSA Edge package (top folder '$project')." }
    $base = "/opt/psa-edge"
    $dir = "$base/$project"
    Step "Unpacking $project into WSL ($dir)"
    if ((Invoke-Wsl "test -d $dir/secrets") -eq 0) {
      Write-Host "  An installation of $project already exists; keeping its secrets and data, refreshing the package files."
    }
    if ((Invoke-Wsl "command -v unzip >/dev/null 2>&1 || (apt-get update -q >/dev/null && apt-get install -y -q unzip >/dev/null)") -ne 0) { Fail 'unzip could not be installed in WSL.' }
    if ((Invoke-Wsl "mkdir -p $base && cd $base && rm -rf $project.new && mkdir $project.new && unzip -q '$zipWsl' -d $project.new && if [ -d $dir ]; then cp -a $dir/secrets $project.new/$project/ 2>/dev/null; cp -a $dir/.env $project.new/$project/ 2>/dev/null; rm -rf $dir; fi && mv $project.new/$project $dir && rm -rf $project.new && cd $dir && sha256sum -c CHECKSUMS.sha256 --quiet") -ne 0) { Fail 'Unpacking or checksum verification failed.' }
    Step 'Local settings (.env)'
    if ((Invoke-Wsl "cd $dir && test -f .env || cp config/edge.env.template .env") -ne 0) { Fail '.env could not be prepared.' }
    $img = Get-WslOutput "sed -n 's/^# PSA_EDGE_IMAGE=//p' $dir/config/edge.env.template | head -n 1"
    Write-Host "  image reference from the package: $(if ($img) { $img } else { '(see compose.yaml)' })"
    Step "Installing (this is the package's own scripts/install.sh, run inside WSL)"
    $flag = if ($Production) { ' --production' } else { '' }
    $installExit = Invoke-Wsl "cd $dir && chmod +x scripts/*.sh && scripts/install.sh$flag"
    Step 'Verifying (the package''s own scripts/verify.sh)'
    $verifyExit = Invoke-Wsl "cd $dir && scripts/verify.sh"
    if ($verifyExit -ne 0) { Fail "Verification failed (install exit $installExit). Logs: wsl -u root bash -c 'cd $dir && docker compose -f compose.yaml logs --tail 50'" }
    if ($installExit -ne 0) { Write-Host "  note: install.sh exited with $installExit but every check passes; the appliance is running." -ForegroundColor Yellow }
    $port = Get-WslOutput "sed -n 's/^EDGE_LOCAL_ADMIN_PORT=//p' $dir/.env | head -n 1"
    Write-Host ''
    Write-Host "Installed: $project" -ForegroundColor Green
    Write-Host "  Local admin UI:  http://localhost:$port   (first visit: create the local administrator, then enter the PSA credentials)"
    Write-Host "  Dashboard:       the deployment shows Enrolled within a minute, Verified after the first health reports."
    Write-Host "  Status later:    .\Install-EdgePackage.ps1 -Status $($project.Substring(6).ToUpper())"
  }
  'Status' {
    $project = ProjectOf $Status; $dir = "/opt/psa-edge/$project"
    if ((Invoke-Wsl "test -d $dir") -ne 0) { Fail "$project is not installed on this machine." }
    Step "$project containers"
    Show-Wsl "cd $dir && docker compose -f compose.yaml ps"
    Step 'Agent'
    Show-Wsl "cd $dir && docker compose -f compose.yaml exec -T edge-agent edge-agent status 2>/dev/null | sed 's/,/,\n  /g' | grep -E 'state|enrolled|lastHeartbeatAt|lastError|detail' || echo '  (agent not running)'"
    Show-Wsl "cd $dir && scripts/verify.sh"
  }
  'Stop' {
    $project = ProjectOf $Stop; $dir = "/opt/psa-edge/$project"
    if ((Invoke-Wsl "test -d $dir") -ne 0) { Fail "$project is not installed on this machine." }
    Step "Stopping $project (data, secrets and .env are kept)"
    Show-Wsl "cd $dir && scripts/uninstall.sh"
  }
  'Wipe' {
    $project = ProjectOf $Wipe; $dir = "/opt/psa-edge/$project"
    if ((Invoke-Wsl "test -d $dir") -ne 0) { Fail "$project is not installed on this machine." }
    $code = $Wipe.ToUpper()
    Write-Host "This deletes the appliance's database, logs, backups, agent state and secrets on this machine." -ForegroundColor Yellow
    $typed = Read-Host "Type $code to confirm"
    if ($typed -ne $code) { Fail 'Not confirmed.' }
    Step "Wiping $project"
    if ((Invoke-Wsl "cd $dir && scripts/uninstall.sh --wipe --confirm $code --force") -ne 0) { Fail 'Wipe failed; see the output above.' }
    Show-Wsl "rm -rf $dir"
    Write-Host "Removed $project from this machine. Decommission or remove the deployment in the dashboard as well." -ForegroundColor Green
  }
}
