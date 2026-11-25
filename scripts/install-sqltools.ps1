param([string]$ComponentsRoot = (Join-Path $env:APPDATA 'com.quervio.app/components'))
$ErrorActionPreference = 'Stop'
$version = '6.0.20261023.1'
$expected = 'dd1ff732896b2a5e54953bd79b3a45d7f1fe14f1f9386242029aff9c650e9f25'
$sep = [IO.Path]::DirectorySeparatorChar
$fullRoot = [IO.Path]::GetFullPath($ComponentsRoot)
$trimmedRoot = $fullRoot.TrimEnd($sep, [IO.Path]::AltDirectorySeparatorChar)
if ($trimmedRoot -match '^[A-Za-z]:$') { $root = $trimmedRoot + $sep } else { $root = $trimmedRoot }
$rootPrefix = if ($root.EndsWith($sep)) { $root } else { $root + $sep }
$sqltoolsRoot = [IO.Path]::GetFullPath((Join-Path $root 'sqltools'))
$directory = [IO.Path]::GetFullPath((Join-Path $sqltoolsRoot $version))
if (-not $directory.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid component directory.' }
$executable = Join-Path $directory 'MicrosoftSqlToolsServiceLayer.exe'
$marker = Join-Path $directory '.installed'
$legacyDll = Join-Path $directory 'Microsoft.SqlTools.ServiceLayer.dll'

function Test-CompleteInstall([string]$dir, [string]$exe, [string]$mark, [string]$dll) {
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $exe).Length -le 0) { return $false }
    return (Test-Path -LiteralPath $mark -PathType Leaf) -or (Test-Path -LiteralPath $dll -PathType Leaf)
}

function Expand-ZipSafe([string]$zipPath, [string]$destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destFull = [IO.Path]::GetFullPath($destination).TrimEnd($sep, [IO.Path]::AltDirectorySeparatorChar)
    $destPrefix = $destFull + $sep
    [IO.Directory]::CreateDirectory($destFull) | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        foreach ($entry in $zip.Entries) {
            $targetPath = [IO.Path]::GetFullPath((Join-Path $destFull $entry.FullName))
            if (-not $targetPath.StartsWith($destPrefix, [StringComparison]::OrdinalIgnoreCase) -and -not $targetPath.Equals($destFull, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Archive entry escapes destination directory: $($entry.FullName)"
            }
            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) {
                [IO.Directory]::CreateDirectory($targetPath) | Out-Null
            } else {
                $parent = [IO.Path]::GetDirectoryName($targetPath)
                if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
            }
        }
    }
    finally {
        $zip.Dispose()
    }
}

[IO.Directory]::CreateDirectory($sqltoolsRoot) | Out-Null
$temporary = Join-Path $sqltoolsRoot ('.install-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    if (-not (Test-CompleteInstall $directory $executable $marker $legacyDll)) {
        if (Test-Path -LiteralPath $directory) {
            throw "Incomplete component directory: $directory. Remove it before retrying."
        }
        $archive = Join-Path $temporary 'service.zip'
        $stageDir = Join-Path $temporary 'service'
        Write-Output 'Downloading official SQL Tools Service...'
        Invoke-WebRequest -Uri 'https://github.com/microsoft/sqltoolsservice/releases/download/6.0.20261023.1/Microsoft.SqlTools.ServiceLayer-win-x64-net10.0.zip' -OutFile $archive -UseBasicParsing
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SQL Tools Service checksum mismatch.' }
        Expand-ZipSafe $archive $stageDir
        $stagedExe = Join-Path $stageDir 'MicrosoftSqlToolsServiceLayer.exe'
        if (-not (Test-Path -LiteralPath $stagedExe -PathType Leaf) -or (Get-Item -LiteralPath $stagedExe).Length -le 0) {
            throw 'SQL Tools Service executable was not found in the archive.'
        }
        [IO.File]::WriteAllText((Join-Path $stageDir '.installed'), "$version`n", [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $directory) {
            throw "Incomplete component directory: $directory. Remove it before retrying."
        }
        [IO.Directory]::Move($stageDir, $directory)
    }
    if (-not (Test-CompleteInstall $directory $executable $marker $legacyDll)) {
        throw 'SQL Tools Service executable was not found in the archive.'
    }
    $tempJson = Join-Path $temporary 'language.json'
    $targetJson = Join-Path $root 'language.json'
    [IO.File]::WriteAllText($tempJson, ($executable | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $targetJson) {
        [IO.File]::Replace($tempJson, $targetJson, $null)
    } else {
        [IO.File]::Move($tempJson, $targetJson)
    }
    Write-Output "SQL Tools Service $version installed and selected."
}
finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}
