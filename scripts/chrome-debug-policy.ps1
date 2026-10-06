# Allow Chrome remote debugging on the default profile (Chrome 136+ blocks it
# by default; this policy re-enables it). Reversible: delete the value.
try {
  New-Item -Path 'HKCU:\Software\Policies\Google\Chrome' -Force -ErrorAction Stop | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Policies\Google\Chrome' -Name DevToolsRemoteDebuggingAllowed -Value 1 -Type DWord -ErrorAction Stop
  Write-Output ("OK DevToolsRemoteDebuggingAllowed=" + (Get-ItemProperty 'HKCU:\Software\Policies\Google\Chrome').DevToolsRemoteDebuggingAllowed)
} catch {
  Write-Output ("FAILED: " + $_.Exception.Message)
  try {
    (Get-Acl 'HKCU:\Software\Policies').Access |
      Select-Object IdentityReference, RegistryRights, AccessControlType | Format-Table | Out-String | Write-Output
  } catch { Write-Output ("acl read failed: " + $_.Exception.Message) }
}
