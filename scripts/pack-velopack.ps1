# Builds Quervio and packs it with Velopack: Setup.exe, the full and delta
# packages and the release feed, under target/velopack/releases.
# -Publish uploads them as a GitHub Release, where installed copies look for
# updates (src-tauri/src/updates.rs). Needs the .NET SDK (vpk is pinned in
# dotnet-tools.json) and, for -Publish, `gh auth login` or -Token.
# -ReleaseNotes is the text of the notes (Markdown), shown in the release.
# -Publish -Draft uploads without publishing, for a combined Windows/Linux release.
param(
    [switch]$Publish,
    [switch]$Draft,
    [string]$Token,
    [string]$ReleaseNotes
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$repo = 'https://github.com/devchristian1337/quervio'
# Not "Quervio": the NSIS installer used %LOCALAPPDATA%\Quervio.
$packId = 'Quervio.App'
$version = (Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
$publishDir = Join-Path $root 'target/velopack/publish'
$releasesDir = Join-Path $root 'target/velopack/releases'

if ($Draft -and -not $Publish) { throw '-Draft requires -Publish.' }
# Cleanup and release output are limited to ordinary directories inside this checkout.
$workspacePath = [IO.Path]::GetFullPath($root.Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
foreach ($directory in @($publishDir, $releasesDir)) {
    $absolute = [IO.Path]::GetFullPath($directory)
    if (-not $absolute.StartsWith($workspacePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build output must stay inside the workspace: $absolute"
    }
}
foreach ($directory in @((Join-Path $root 'target'), (Join-Path $root 'target/velopack'), $publishDir, $releasesDir)) {
    if (Test-Path -LiteralPath $directory) {
        if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Build output must not traverse a reparse point: $directory"
        }
    }
}

function Invoke-Step([string]$what, [scriptblock]$step) {
    # Windows PowerShell turns a tool's stderr (Tauri logs its progress
    # there) into a terminating error when output is redirected: the exit
    # code decides instead.
    $ErrorActionPreference = 'Continue'
    & $step
    if ($LASTEXITCODE -ne 0) { throw "$what failed." }
}

function Invoke-VpkWithToken([string]$what, [string[]]$arguments, [string]$tokenValue) {
    # Pass --token via a private response file (@file) so the GitHub token never
    # appears in process command lines (Win32_Process.CommandLine / audit logs).
    $rspDir = Join-Path $root 'target/velopack'
    [IO.Directory]::CreateDirectory($rspDir) | Out-Null
    $rspFile = Join-Path $rspDir ('.vpk-token-' + [Guid]::NewGuid().ToString('N') + '.rsp')
    try {
        [IO.File]::WriteAllText($rspFile, '', [Text.UTF8Encoding]::new($false))
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $rspFile -AclObject $acl
        [IO.File]::WriteAllText($rspFile, "--token`n$tokenValue`n", [Text.UTF8Encoding]::new($false))
        Invoke-Step $what { dotnet vpk @arguments "@$rspFile" }
    }
    finally {
        if (Test-Path -LiteralPath $rspFile) {
            try {
                $len = (Get-Item -LiteralPath $rspFile).Length
                if ($len -gt 0) { [IO.File]::WriteAllBytes($rspFile, (New-Object byte[] $len)) }
            } catch {}
            Remove-Item -LiteralPath $rspFile -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'src-tauri/resources/microsoft/Quervio.MicrosoftBridge.exe'))) {
    throw 'The Microsoft bridge is missing: run scripts/build-microsoft.ps1 first.'
}

# A missing tool otherwise fails halfway through the build with a vague error.
$tools = @('dotnet', 'pnpm', 'cargo')
if ($Publish -and -not $Token) { $tools += 'gh' }
$missing = @($tools | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
if ($missing.Count -gt 0) {
    throw "Not found on PATH: $($missing -join ', '). Install them, then open a new terminal."
}

Push-Location -LiteralPath $root
try {
    Invoke-Step 'vpk restore' { dotnet tool restore }
    # A fresh or older clone lacks node_modules, the Tauri CLI included.
    Invoke-Step 'pnpm install' { pnpm install --frozen-lockfile }
    Invoke-Step 'Tauri build' { pnpm tauri build --no-bundle }

    $cargoTargetDir = (cargo metadata --no-deps --format-version 1 | ConvertFrom-Json).target_directory
    if (-not $cargoTargetDir) { throw 'Could not determine Cargo target directory.' }

    # The same layout as tauri.conf.json's bundle.resources, next to the exe:
    # on Windows Tauri's resource_dir() is the exe's folder.
    if (Test-Path -LiteralPath $publishDir) { Remove-Item -LiteralPath $publishDir -Recurse -Force }
    [IO.Directory]::CreateDirectory($publishDir) | Out-Null
    Copy-Item -LiteralPath (Join-Path $cargoTargetDir 'release/quervio.exe') -Destination $publishDir
    Copy-Item -LiteralPath (Join-Path $root 'src-tauri/resources/microsoft') -Destination (Join-Path $publishDir 'microsoft') -Recurse
    Remove-Item -LiteralPath (Join-Path $publishDir 'microsoft/README.txt') -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $root 'scripts/install-sqltools.ps1') -Destination $publishDir

    if ($Publish) {
        if (-not $Token) { $Token = gh auth token }
        if (-not $Token) { throw 'No GitHub token: run gh auth login or pass -Token.' }
        # The previous release, so vpk can build a delta package from it.
        Invoke-VpkWithToken 'vpk download' @('download', 'github', '-o', $releasesDir, '--repoUrl', $repo) $Token
    }

    $pack = @(
        'pack', '-u', $packId, '-v', $version, '-p', $publishDir, '-o', $releasesDir,
        '-e', 'quervio.exe', '--packTitle', 'Quervio', '--packAuthors', 'devchristian1337',
        '--icon', 'src-tauri/icons/icon.ico', '--splashImage', 'src/assets/quervio-q-prisma-v2.png',
        '--framework', 'webview2', '--runtime', 'win-x64'
    )
    if ($ReleaseNotes) {
        # vpk reads the notes from a Markdown file, not from the argument.
        $notesFile = Join-Path $root 'target/velopack/release-notes.md'
        [IO.File]::WriteAllText($notesFile, $ReleaseNotes, [Text.UTF8Encoding]::new($false))
        $pack += @('--releaseNotes', $notesFile)
    }
    Invoke-Step 'vpk pack' { dotnet vpk @pack }

    if ($Publish) {
        $upload = @('upload', 'github', '-o', $releasesDir, '--repoUrl', $repo,
            '--merge', '--releaseName', "Quervio $version", '--tag', "v$version")
        if (-not $Draft) { $upload += '--publish' }
        Invoke-VpkWithToken 'vpk upload' $upload $Token
    }
    Write-Host "Setup: $(Join-Path $releasesDir "$packId-win-Setup.exe")"
}
finally {
    Pop-Location
}
