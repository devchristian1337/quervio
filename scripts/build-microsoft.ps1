param(
    [string]$Dotnet = 'dotnet',
    [string]$Output = (Join-Path $PSScriptRoot '../src-tauri/resources/microsoft')
)
$ErrorActionPreference = 'Stop'
if ($Dotnet -eq 'dotnet' -and $env:LOCALAPPDATA) {
    $localSdk = Join-Path $env:LOCALAPPDATA 'Quervio/dotnet/dotnet.exe'
    if (Test-Path -LiteralPath $localSdk) { $Dotnet = $localSdk }
}
$project = Join-Path $PSScriptRoot '../tools/Quervio.MicrosoftBridge/Quervio.MicrosoftBridge.csproj'
$outputFull = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $outputFull) {
    if ((Get-Item -LiteralPath $outputFull).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Output directory must not be a reparse point: $outputFull"
    }
}
$stage = Join-Path ([IO.Path]::GetTempPath()) ('quervio-bridge-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null

function Invoke-Publish([string]$exe, [string]$csproj, [string]$dest) {
    # Windows PowerShell 5.1 turns stderr lines into terminating NativeCommandError
    # when $ErrorActionPreference is Stop and output is redirected (e.g. 2>&1).
    $ErrorActionPreference = 'Continue'
    & $exe publish $csproj -c Release -r win-x64 --self-contained true -o $dest
    if ($LASTEXITCODE -ne 0) { throw 'Microsoft bridge build failed.' }
}

try {
    Invoke-Publish $Dotnet $project $stage
    $produced = @(Get-ChildItem -LiteralPath $stage -Force)
    if ($produced.Count -gt 0) {
        [IO.Directory]::CreateDirectory($outputFull) | Out-Null
        foreach ($stale in @(Get-ChildItem -LiteralPath $outputFull -Force | Where-Object { $_.Name -ne 'README.txt' })) {
            Remove-Item -LiteralPath $stale.FullName -Recurse -Force
        }
        foreach ($item in $produced) {
            Copy-Item -LiteralPath $item.FullName -Destination $outputFull -Recurse -Force
        }
    }
}
finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
