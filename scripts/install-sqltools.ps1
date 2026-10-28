param([string]$ComponentsRoot = (Join-Path $env:APPDATA 'com.quervio.app/components'))
$ErrorActionPreference = 'Stop'
$version = '6.0.20261023.1'
$expected = 'dd1ff732896b2a5e54953bd79b3a45d7f1fe14f1f9386242029aff9c650e9f25'
$root = [IO.Path]::GetFullPath($ComponentsRoot)
$directory = [IO.Path]::GetFullPath((Join-Path $root "sqltools/$version"))
if (-not $directory.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid component directory.' }
$executable = Join-Path $directory 'MicrosoftSqlToolsServiceLayer.exe'
if (-not (Test-Path -LiteralPath $executable)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $archive = Join-Path $directory 'service.zip'
    Write-Output 'Downloading official SQL Tools Service...'
    Invoke-WebRequest -Uri 'https://github.com/microsoft/sqltoolsservice/releases/download/6.0.20261023.1/Microsoft.SqlTools.ServiceLayer-win-x64-net10.0.zip' -OutFile $archive -UseBasicParsing
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SQL Tools Service checksum mismatch.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
    Remove-Item -LiteralPath $archive
}
if (-not (Test-Path -LiteralPath $executable)) { throw 'SQL Tools Service executable was not found in the archive.' }
[IO.File]::WriteAllText((Join-Path $root 'language.json'), ($executable | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
Write-Output "SQL Tools Service $version installed and selected."
