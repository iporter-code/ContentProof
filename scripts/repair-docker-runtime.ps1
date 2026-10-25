param([switch]$Recover)
$ErrorActionPreference = 'Stop'
# This workaround preserves socket-only directories. It is not an upstream fix.
$dockerCli = (Get-Command docker -ErrorAction Stop).Source
$installRoot = Split-Path (Split-Path (Split-Path $dockerCli -Parent) -Parent) -Parent
$desktopExe = Join-Path $installRoot 'Docker Desktop.exe'
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw 'Docker Desktop installation not found' }
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
$targets = @(
    @{ Path = Join-Path $localRoot 'Docker\run'; Names = @('dockerEthernetVfkit','dockerInference','sailor-ingest.sock','userAnalyticsOtlpHttp.sock') },
    @{ Path = Join-Path $localRoot 'docker-secrets-engine'; Names = @('engine.sock') }
)
function Assert-RuntimeDirectory($entry) {
    $path = [IO.Path]::GetFullPath($entry.Path)
    if (-not $path.StartsWith($localRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe runtime path' }
    if (-not (Test-Path -LiteralPath $path)) { return }
    $dir = Get-Item -LiteralPath $path -Force
    if (-not $dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected runtime directory type' }
    foreach ($file in Get-ChildItem -LiteralPath $path -Force) {
        $name = $file.Name -replace '\.stale$', ''
        if ($file.PSIsContainer -or $file.Length -ne 0 -or $name -notin $entry.Names -or -not ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to move runtime directory containing an unexpected entry: $($file.Name)"
        }
    }
}
foreach ($entry in $targets) { Assert-RuntimeDirectory $entry }
if (-not $Recover) {
    Write-Output "Docker Desktop $((Get-Item -LiteralPath $desktopExe).VersionInfo.FileVersion)"
    Write-Output 'Runtime directory validation passed. No changes made. Use -Recover only when the Docker engine is unavailable.'
    exit 0
}
# Never interrupt a healthy engine or its running containers.
$ErrorActionPreference = 'Continue'
$engine = & $dockerCli version --format '{{.Server.Version}}' 2>$null
$engineCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($engineCode -eq 0 -and $engine) { throw 'Docker engine is healthy; recovery refused' }
$prefix = $installRoot.TrimEnd('\') + '\'
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(Docker Desktop|com\.docker\.backend)\.exe$' -and
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(Docker Desktop|com\.docker\.backend)\.exe$' -and
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}) { throw 'Docker processes have not stopped; no directories moved' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
foreach ($entry in $targets) {
    Assert-RuntimeDirectory $entry
    $path = [IO.Path]::GetFullPath($entry.Path)
    $backup = $path + '.before-contentproof-' + $stamp
    if (Test-Path -LiteralPath $backup) { throw 'Preservation destination already exists' }
    if (Test-Path -LiteralPath $path) { Move-Item -LiteralPath $path -Destination $backup }
    New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    Write-Output "Preserved runtime directory: $backup"
}
Start-Process -FilePath $desktopExe -WindowStyle Hidden
Write-Output 'Docker Desktop launched. Verify engine health separately. Images, volumes, WSL disks and settings were not modified by this script.'
