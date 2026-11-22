$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$startMenuRoots = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
$allowedRoots = @(
  $env:ProgramFiles,
  ${env:ProgramFiles(x86)},
  (Join-Path $env:LOCALAPPDATA 'Programs')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$excludedTargets = '^(uninstall|unins\d*|setup|installer|update|repair|powershell|pwsh|cmd|wscript|cscript|mshta|reg|rundll32|taskkill|shutdown)\.exe$'
$apps = New-Object System.Collections.Generic.List[object]
$seenTargets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$shell = New-Object -ComObject WScript.Shell

foreach ($root in $startMenuRoots) {
  $shortcuts = Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
  foreach ($file in $shortcuts) {
    try {
      $shortcut = $shell.CreateShortcut($file.FullName)
      if (-not [string]::IsNullOrWhiteSpace($shortcut.Arguments) -or
          [string]::IsNullOrWhiteSpace($shortcut.TargetPath)) {
        continue
      }

      $target = [System.IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($shortcut.TargetPath)
      )
      if ([System.IO.Path]::GetExtension($target) -ine '.exe' -or
          [System.IO.Path]::GetFileName($target) -match $excludedTargets -or
          -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        continue
      }

      $allowed = $false
      foreach ($allowedRoot in $allowedRoots) {
        $prefix = $allowedRoot.TrimEnd('\') + '\'
        if ($target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          $allowed = $true
          break
        }
      }
      if (-not $allowed -or -not $seenTargets.Add($target)) { continue }

      $name = [System.IO.Path]::GetFileNameWithoutExtension($file.Name).Trim()
      if ($name) {
        $apps.Add([PSCustomObject]@{ name = $name; path = $target })
      }
    } catch {
      [Console]::Error.WriteLine('No se pudo leer el acceso directo: ' + $file.Name)
    }
  }
}

$json = ConvertTo-Json -InputObject @($apps.ToArray()) -Compress
[Console]::Out.WriteLine($json)
