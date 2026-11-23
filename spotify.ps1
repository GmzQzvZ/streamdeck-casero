$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$mediaPropertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media, ContentType=WindowsRuntime]
$booleanType = [bool]
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
    $_.ToString().Contains('IAsyncOperation`1[TResult]')
  } |
  Select-Object -First 1

if (-not $asTaskMethod) {
  throw 'No se encontró el adaptador de operaciones asíncronas de Windows'
}

function Wait-WinRtOperation($operation, [Type]$resultType) {
  $closedMethod = $asTaskMethod.MakeGenericMethod([Type[]]@($resultType))
  $task = $closedMethod.Invoke($null, @($operation))
  return $task.GetAwaiter().GetResult()
}

$managerOperation = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]::RequestAsync()
$manager = Wait-WinRtOperation $managerOperation $managerType

function Get-SpotifySession {
  $currentSession = $manager.GetCurrentSession()
  if ($currentSession -and $currentSession.SourceAppUserModelId -match 'spotify') {
    return $currentSession
  }
  foreach ($session in $manager.GetSessions()) {
    if ($session.SourceAppUserModelId -match 'spotify') {
      return $session
    }
  }
  return $null
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $session = Get-SpotifySession
    if (-not $session) {
      if ($request.action -eq 'status') {
        $value = @{ available = $false; title = ''; artist = ''; isPlaying = $false }
      } else {
        throw 'No hay una sesión multimedia de Spotify disponible'
      }
    } elseif ($request.action -eq 'status') {
      $propertiesOperation = $session.TryGetMediaPropertiesAsync()
      $properties = Wait-WinRtOperation $propertiesOperation $mediaPropertiesType
      $playbackStatus = $session.GetPlaybackInfo().PlaybackStatus.ToString()
      $value = @{
        available = $true
        title = $properties.Title
        artist = $properties.Artist
        isPlaying = $playbackStatus -eq 'Playing'
      }
    } else {
      switch ($request.action) {
        'playpause' { $operation = $session.TryTogglePlayPauseAsync() }
        'next' { $operation = $session.TrySkipNextAsync() }
        'prev' { $operation = $session.TrySkipPreviousAsync() }
        default { throw 'Comando de Spotify no válido' }
      }
      if (-not (Wait-WinRtOperation $operation $booleanType)) {
        throw 'Spotify no pudo ejecutar el comando solicitado'
      }
      $value = @{ ok = $true }
    }
    $response = @{ id = $request.id; ok = $true; value = $value }
  } catch {
    $response = @{ id = $request.id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
