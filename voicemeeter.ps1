$ErrorActionPreference = 'Stop'
$apiDll = 'C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll'
if (-not (Test-Path $apiDll)) {
  throw 'No se encuentra VoicemeeterRemote64.dll'
}

$source = @"
using System;
using System.Runtime.InteropServices;

public static class VoicemeeterRemote
{
    private const string Dll = @"$apiDll";

    [DllImport(Dll, EntryPoint = "VBVMR_Login", CallingConvention = CallingConvention.StdCall)]
    public static extern int Login();

    [DllImport(Dll, EntryPoint = "VBVMR_Logout", CallingConvention = CallingConvention.StdCall)]
    public static extern int Logout();

    [DllImport(Dll, EntryPoint = "VBVMR_GetParameterFloat", CallingConvention = CallingConvention.StdCall)]
    private static extern int GetParameterFloat([MarshalAs(UnmanagedType.LPStr)] string name, out float value);

    [DllImport(Dll, EntryPoint = "VBVMR_SetParameterFloat", CallingConvention = CallingConvention.StdCall)]
    private static extern int SetParameterFloat([MarshalAs(UnmanagedType.LPStr)] string name, float value);

    public static float Get(string name)
    {
        float value;
        int result = GetParameterFloat(name, out value);
        if (result != 0) throw new Exception("No se pudo leer " + name + " (API " + result + ")");
        return value;
    }

    public static void Set(string name, float value)
    {
        int result = SetParameterFloat(name, value);
        if (result != 0) throw new Exception("No se pudo cambiar " + name + " (API " + result + ")");
    }
}
"@

Add-Type -TypeDefinition $source
$loginResult = [VoicemeeterRemote]::Login()
if ($loginResult -ne 0) {
  throw "No se pudo conectar con Voicemeeter Remote API (API $loginResult)"
}

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }

    try {
      $request = ConvertFrom-Json -InputObject $line
      $param = [string]$request.param
      if ($param -notmatch '^(Strip|Bus)\[[0-4]\]\.(Mute|Gain)$') {
        throw 'Parametro Voicemeeter invalido'
      }

      $current = [VoicemeeterRemote]::Get($param)
      if ($request.action -eq 'read') {
        $value = $current
      } elseif ($request.action -eq 'toggleMute' -and $param.EndsWith('.Mute')) {
        $toggleParam = $param -replace '\.Mute$', '.mute'
        [VoicemeeterRemote]::Set($toggleParam + ' += 1', 0.0)
        Start-Sleep -Milliseconds 30
        $value = [VoicemeeterRemote]::Get($param)
      } elseif ($request.action -eq 'changeGain' -and $param.EndsWith('.Gain')) {
        $next = [Math]::Max(-60.0, [Math]::Min(12.0, $current + [double]$request.delta))
        [VoicemeeterRemote]::Set($param, [single]$next)
        $value = [VoicemeeterRemote]::Get($param)
      } elseif ($request.action -eq 'changeVolumePercent' -and $param.EndsWith('.Gain')) {
        $percent = [Math]::Round((($current + 60.0) / 72.0) * 100.0)
        $nextPercent = [Math]::Max(0, [Math]::Min(100, $percent + [int]$request.delta))
        $next = -60.0 + ($nextPercent / 100.0 * 72.0)
        $change = $next - $current
        if ($change -ne 0) {
          $gainParam = $param -replace '\.Gain$', '.gain'
          $changeText = [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:0.######}', $change)
          [VoicemeeterRemote]::Set($gainParam + ' += ' + $changeText, 0.0)
        }
        $value = [int]$nextPercent
      } else {
        throw 'Accion Voicemeeter invalida'
      }

      @{ ok = $true; value = $value } | ConvertTo-Json -Compress
    } catch {
      @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
  }
} finally {
  [VoicemeeterRemote]::Logout() | Out-Null
}
