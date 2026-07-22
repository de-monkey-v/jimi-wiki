param(
  [Parameter(Mandatory = $true)]
  [string]$Distro,
  [string]$LinuxUser = "gyu"
)

$ErrorActionPreference = "Stop"
$taskName = "Jimi Wiki WSL Startup"
$wsl = Join-Path $env:WINDIR "System32\wsl.exe"
$arguments = "-d `"$Distro`" -u `"$LinuxUser`" --exec /bin/true"
$action = New-ScheduledTaskAction -Execute $wsl -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

$task = @{
  TaskName = $taskName
  Action = $action
  Trigger = $trigger
  Settings = $settings
  Description = "Start the Jimi Wiki WSL distribution so linger-enabled user services recover after Windows login."
  User = "$env:USERDOMAIN\$env:USERNAME"
  RunLevel = "Limited"
  Force = $true
}
Register-ScheduledTask @task | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "Registered and started '$taskName' for WSL distribution '$Distro' as Linux user '$LinuxUser'."
