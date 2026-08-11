<#
.SYNOPSIS
  Turn this Windows machine into an ssh target, bound to loopback only.

.DESCRIPTION
  Agbrte installs its host on the machine it controls (DESIGN.md 6.3), so a
  Windows target needs a different bootstrap from the POSIX one. That bootstrap
  is verified against this machine directly; what this script enables is the one
  remaining layer, ssh itself.

  ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 reads a .ps1 with no byte
  order mark as ANSI rather than UTF-8. An em dash is three UTF-8 bytes that
  decode under cp1252 to a-circumflex, euro, and a right curly quote -- and
  PowerShell accepts a curly quote as a string delimiter. The first version of
  this file used em dashes in its messages and died with "The string is missing
  the terminator", pointing at a line nine rows below the real one. This file is
  also written with a BOM, which is the other half of the fix.

  WHAT IT CHANGES

    1. Installs the OpenSSH Server Windows capability.        (removable)
    2. Starts it once so it writes its config and host keys.
    3. Adds "ListenAddress 127.0.0.1" to sshd_config, so it accepts connections
       from this machine only and is not on the network at all.
    4. Disables the inbound firewall rule the capability adds. Belt and braces:
       with the ListenAddress above there is nothing for it to allow, and a rule
       permitting something impossible is still a rule somebody has to reason
       about later.
    5. Sets the service to Manual, not Automatic, so it does not come back on
       the next boot unless you start it.

  WHAT IT DOES NOT DO

  It does not touch anybody's keys. Authorising a key happens in the user's own
  context and needs no administrator.

  UNDO

      Stop-Service sshd
      Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

  That removes the service and the binaries. C:\ProgramData\ssh is left holding
  the generated host keys; delete it if you want nothing at all.

.NOTES
  Requires elevation. From a normal window:

      Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','C:\dev\loom\scripts\enable-sshd.ps1'
#>

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host ""
  Write-Host "This needs an elevated PowerShell." -ForegroundColor Yellow
  Write-Host "Run this from your normal window and accept the UAC prompt:" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','$PSCommandPath'"
  Write-Host ""
  exit 1
}

Write-Host "1. installing the OpenSSH Server capability..." -ForegroundColor Cyan
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
if ($cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
  Write-Host "   installed."
} else {
  Write-Host "   already installed."
}

Write-Host "2. making sure it has a config and host keys..." -ForegroundColor Cyan
#
# Nothing is started here, and that is the point.
#
# This step used to start the service so it would write its defaults. That works
# exactly once: on a re-run against a config this script had already broken, it
# died here and never reached the repair below. A script that cannot recover from
# its own last run is not idempotent, it is single-use.
#
# It is also the wrong order on principle. Starting a service to find out whether
# its config is valid is what step 3b exists to replace: both files can be
# produced without running anything.
Set-Service sshd -StartupType Manual
$config = Join-Path $env:ProgramData 'ssh\sshd_config'

if (-not (Test-Path $config)) {
  $default = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd_config_default'
  if (Test-Path $default) {
    New-Item -ItemType Directory -Force -Path (Split-Path $config) | Out-Null
    Copy-Item $default $config
    Write-Host "   wrote a config from sshd_config_default."
  } else {
    throw "no config at $config and no default at $default"
  }
} else {
  Write-Host "   config already present."
}

# Host keys, generated without the service. -A only creates what is missing.
$keygen = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
& $keygen -A | Out-Null
Write-Host "   host keys present."

# If it is running from an earlier attempt, stop it: everything below edits the
# config, and a running sshd would keep serving the old one.
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') {
  Stop-Service sshd
  Write-Host "   stopped the running service before editing its config."
}

Write-Host "3. binding it to loopback only..." -ForegroundColor Cyan
#
# Inserted BEFORE the first Match block, not appended.
#
# The default Windows sshd_config ends with:
#
#     Match Group administrators
#            AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
#
# and everything after a Match line belongs to that block until the next one.
# ListenAddress is a global-only directive, so appending it to the end of the
# file puts it somewhere it is not allowed and sshd refuses the whole config.
# The service then fails to start with "Failed to start service", which says
# nothing about a config file at all.
#
# The first version of this script appended, and its idempotency check then saw
# the line and reported "already bound" on every re-run, so it could never have
# repaired itself. This one removes any block it wrote before, wherever it
# landed, and puts it back in the right place.
$marker = "# Added by Agbrte enable-sshd.ps1"
$lines = @(Get-Content $config)

# Drop any block this script wrote before, wherever it ended up. Three lines:
# the marker, one more comment, and the directive.
$kept = @()
$skip = 0
foreach ($l in $lines) {
  if ($l -like "$marker*") { $skip = 2; continue }
  if ($skip -gt 0) { $skip--; continue }
  $kept += $l
}

$block = @(
  ($marker + ". This machine is an ssh target for"),
  "# testing only and must not be reachable from the network.",
  "ListenAddress 127.0.0.1"
)

$matchAt = -1
for ($i = 0; $i -lt $kept.Count; $i++) {
  if ($kept[$i] -match '^\s*Match\s') { $matchAt = $i; break }
}

# Plain array concatenation, not List.AddRange.
#
# AddRange with a cast collapsed the three lines into one, joined by spaces --
# and because the first of them is a comment, the whole thing became a comment
# and ListenAddress was never applied at all. sshd would have started cleanly and
# stayed bound to every interface: a silent success that leaves the machine
# exposed, which is far worse than the crash it replaced. Caught by printing the
# result instead of trusting it.
if ($matchAt -ge 0) {
  $head = if ($matchAt -gt 0) { $kept[0..($matchAt - 1)] } else { @() }
  $tail = $kept[$matchAt..($kept.Count - 1)]
  $out = @($head) + $block + @("") + @($tail)
  Write-Host "   inserted above the Match block at line $($matchAt + 1)."
} else {
  $out = @($kept) + $block
  Write-Host "   appended (no Match block in this config)."
}

# Every line of the block must be its own line, and the directive must not be
# commented out. Checked here because the failure mode above is invisible.
$written = @($out | Where-Object { $_ -eq "ListenAddress 127.0.0.1" })
if ($written.Count -ne 1) {
  throw "the ListenAddress line did not survive as its own line (found $($written.Count))"
}

# ASCII, and no BOM: a byte order mark at the top of sshd_config is itself a
# parse error, which would be the same failure by a different route.
Set-Content -Path $config -Value $out -Encoding ASCII

Write-Host "3b. validating the config before starting anything..." -ForegroundColor Cyan
# sshd -T prints the effective configuration or explains what it dislikes. Doing
# this here is the difference between a sentence naming a line and "Failed to
# start service", which is what the first version of this script produced.
$sshd = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe'
$check = & $sshd -T 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "   sshd rejected the config:" -ForegroundColor Red
  $check | ForEach-Object { Write-Host "     $_" -ForegroundColor Red }
  throw "sshd_config is not valid; nothing was started"
}
$bound = @($check | Where-Object { $_ -match '^listenaddress' })
Write-Host "   config is valid. $($bound -join ', ')"

Write-Host "4. disabling the inbound firewall rule..." -ForegroundColor Cyan
$rules = @(Get-NetFirewallRule | Where-Object { $_.Name -like '*OpenSSH-Server*' -or $_.DisplayName -like '*OpenSSH Server*' })
if ($rules.Count -gt 0) {
  $rules | Disable-NetFirewallRule
  Write-Host "   disabled $($rules.Count) rule(s)."
} else {
  Write-Host "   none found, nothing to disable."
}

Write-Host "5. starting the service..." -ForegroundColor Cyan
Start-Service sshd
Start-Sleep -Seconds 1

$svc = Get-Service sshd
Write-Host ""
Write-Host "service        : $($svc.Status), startup $($svc.StartType)" -ForegroundColor Green

$listening = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)
if ($listening.Count -gt 0) {
  foreach ($l in $listening) {
    Write-Host "listening      : $($l.LocalAddress):$($l.LocalPort)" -ForegroundColor Green
  }
  $external = @($listening | Where-Object { $_.LocalAddress -ne '127.0.0.1' -and $_.LocalAddress -ne '::1' })
  if ($external.Count -gt 0) {
    Write-Host "WARNING        : listening on a non-loopback address. Check $config" -ForegroundColor Red
  } else {
    Write-Host "reachable from : this machine only" -ForegroundColor Green
  }
} else {
  Write-Host "listening      : nothing on port 22. Check $config" -ForegroundColor Red
}

Write-Host "6. authorising your key in the file sshd will actually read..." -ForegroundColor Cyan
#
# Which file that is depends on whether you are an administrator, and the obvious
# way to ask is wrong.
#
# The default config ends with
#
#     Match Group administrators
#            AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
#
# so for an administrator sshd ignores ~/.ssh/authorized_keys entirely. Checking
# membership with WindowsPrincipal.IsInRole from a NON-elevated shell reports
# False even for an administrator, because UAC hands that process a token in
# which the Administrators group is marked deny-only. I trusted that answer,
# concluded this account was an ordinary user, put the key in ~/.ssh, and got
# "Permission denied (publickey)" with everything else correct.
#
# Get-LocalGroupMember asks the account database instead of the current token,
# which is the question that was actually meant.
$me = "$env:USERDOMAIN\$env:USERNAME"
$admins = @(Get-LocalGroupMember -Group Administrators | ForEach-Object { $_.Name })
$isAdmin = $admins -contains $me

if ($isAdmin) {
  $target = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
  Write-Host "   $me is an administrator, so sshd reads $target"
} else {
  $target = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
  Write-Host "   $me is an ordinary user, so sshd reads $target"
}

$pub = Join-Path $env:USERPROFILE '.ssh\id_rsa.pub'
if (-not (Test-Path $pub)) { throw "no public key at $pub -- run ssh-keygen first" }
$key = (Get-Content $pub -Raw).Trim()

$existing = if (Test-Path $target) { Get-Content $target -Raw } else { "" }
if ($existing -match [regex]::Escape($key)) {
  Write-Host "   key already present."
} else {
  Add-Content -Path $target -Value $key -Encoding ASCII
  Write-Host "   key added."
}

if ($isAdmin) {
  # sshd refuses this file if anyone besides Administrators and SYSTEM can write
  # it, and reports that as an authentication failure rather than as a permission
  # problem -- so it is set here rather than left to inheritance.
  icacls $target /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
  Write-Host "   permissions restricted to Administrators and SYSTEM."
}

Restart-Service sshd
Write-Host "   sshd restarted."

Write-Host ""
Write-Host "Now test it from your normal window:" -ForegroundColor Cyan
Write-Host '  ssh -o BatchMode=yes localhost "echo it works"'

Write-Host ""
Write-Host "To undo: Stop-Service sshd; Remove-WindowsCapability -Online -Name $($cap.Name)"
