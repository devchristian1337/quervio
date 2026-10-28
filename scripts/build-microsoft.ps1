param([string]$Dotnet = 'dotnet')
$ErrorActionPreference = 'Stop'
if ($Dotnet -eq 'dotnet') {
    $localSdk = Join-Path $env:LOCALAPPDATA 'Quervio/dotnet/dotnet.exe'
    if (Test-Path -LiteralPath $localSdk) { $Dotnet = $localSdk }
}
$project = Join-Path $PSScriptRoot '../tools/Quervio.MicrosoftBridge/Quervio.MicrosoftBridge.csproj'
$output = Join-Path $PSScriptRoot '../src-tauri/resources/microsoft'
& $Dotnet publish $project -c Release -r win-x64 --self-contained true -o $output
if ($LASTEXITCODE -ne 0) { throw 'Microsoft bridge build failed.' }
