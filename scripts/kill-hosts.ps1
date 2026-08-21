# Every Agbrte host process on this machine, and its forked agent host.
#
# A host is detached on purpose (§6.4) and lingers past the client that started
# it, so a suite run leaves some behind for AGBRTE_HOST_LINGER_MS. CI starts with
# none; this is how a developer's machine is made to match before a run that is
# supposed to prove something about isolation.
$found = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    ($_.CommandLine -match 'agbrteHost\.js' -or $_.CommandLine -match 'agentHost\.js') -and
    $_.CommandLine -notmatch 'kill-hosts'
  }
foreach ($p in $found) {
  Write-Output ("killing {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Output ("hosts killed: {0}" -f @($found).Count)
