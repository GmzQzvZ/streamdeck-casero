$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$startMenuRoots = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
$allowedRoots = @(
  $env:ProgramFiles,
  ${env:ProgramFiles(x86)},
  (Join-Path $env:LOCALAPPDATA 'Programs'),
  $env:LOCALAPPDATA
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$excludedTargets = '^(uninstall|unins\d*|setup|installer|update|repair|powershell|pwsh|cmd|wscript|cscript|mshta|reg|rundll32|taskkill|shutdown)\.exe$'
$apps = New-Object System.Collections.Generic.List[object]
$seenTargets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$seenNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$shell = New-Object -ComObject WScript.Shell

function Add-Application {
  param([string]$Name, [string]$Target)

  if ([string]::IsNullOrWhiteSpace($Name) -or [string]::IsNullOrWhiteSpace($Target)) { return }
  try {
    $target = [System.IO.Path]::GetFullPath(
      [Environment]::ExpandEnvironmentVariables($Target.Trim('"'))
    )
  } catch {
    return
  }
  if ([System.IO.Path]::GetExtension($target) -ine '.exe' -or
      [System.IO.Path]::GetFileName($target) -match $excludedTargets -or
      -not (Test-Path -LiteralPath $target -PathType Leaf)) {
    return
  }

  $allowed = $false
  foreach ($allowedRoot in $allowedRoots) {
    $prefix = $allowedRoot.TrimEnd('\') + '\'
    if ($target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $allowed = $true
      break
    }
  }
  if (-not $allowed -or $seenTargets.Contains($target)) { return }

  $name = $Name.Trim()
  if ($name.Length -gt 80) { $name = $name.Substring(0, 80) }
  if ($seenNames.Contains($name)) { return }
  $null = $seenTargets.Add($target)
  $null = $seenNames.Add($name)
  $apps.Add([PSCustomObject]@{ name = $name; path = $target })
}

$discordRoot = Join-Path $env:LOCALAPPDATA 'Discord'
$discordExe = Join-Path $discordRoot 'Discord.exe'
if (-not (Test-Path -LiteralPath $discordExe -PathType Leaf) -and
    (Test-Path -LiteralPath $discordRoot -PathType Container)) {
  $discordInstall = Get-ChildItem -LiteralPath $discordRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($discordInstall) {
    $discordExe = Join-Path $discordInstall.FullName 'Discord.exe'
  }
}
Add-Application 'Discord' $discordExe

$fivemExe = Join-Path $env:LOCALAPPDATA 'FiveM\FiveM.exe'
Add-Application 'FiveM' $fivemExe

foreach ($root in $startMenuRoots) {
  $shortcuts = Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
  foreach ($file in $shortcuts) {
    try {
      $shortcut = $shell.CreateShortcut($file.FullName)
      if (-not [string]::IsNullOrWhiteSpace($shortcut.Arguments) -or
          [string]::IsNullOrWhiteSpace($shortcut.TargetPath)) {
        continue
      }

      Add-Application ([System.IO.Path]::GetFileNameWithoutExtension($file.Name)) $shortcut.TargetPath
    } catch {
      [Console]::Error.WriteLine('No se pudo leer el acceso directo: ' + $file.Name)
    }
  }
}

$uninstallLocations = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($location in $uninstallLocations) {
  foreach ($entry in @(Get-ItemProperty -Path $location -ErrorAction SilentlyContinue)) {
    if ([string]::IsNullOrWhiteSpace($entry.DisplayName) -or
        [string]::IsNullOrWhiteSpace($entry.DisplayIcon)) {
      continue
    }

    $displayIcon = [Environment]::ExpandEnvironmentVariables([string]$entry.DisplayIcon)
    $target = $null
    if ($displayIcon -match '^\s*"([^"]+\.exe)"') {
      $target = $matches[1]
    } elseif ($displayIcon -match '^\s*(.+?\.exe)(?:,\s*-?\d+)?\s*$') {
      $target = $matches[1]
    }
    if ($target) { Add-Application ([string]$entry.DisplayName) $target }
  }
}

$json = ConvertTo-Json -InputObject @($apps.ToArray() | Sort-Object -Property name) -Compress
[Console]::Out.WriteLine($json)
