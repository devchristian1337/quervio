# Builds Quervio and packs it with Velopack: Setup.exe, the full and delta
# packages and the release feed, under target/velopack/releases.
# -Publish uploads them as a GitHub Release, where installed copies look for
# updates (src-tauri/src/updates.rs). Needs the .NET SDK (vpk is pinned in
# dotnet-tools.json) and, for -Publish, `gh auth login` or -Token.
# -ReleaseNotes is the text of the notes (Markdown), shown in the release.
param(
    [switch]$Publish,
    [string]$Token,
    [string]$ReleaseNotes
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$repo = 'https://github.com/devchristian1337/quervio'
# Not "Quervio": the NSIS installer used %LOCALAPPDATA%\Quervio.
$packId = 'Quervio.App'
$version = (Get-Content (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
$publishDir = Join-Path $root 'target/velopack/publish'
$releasesDir = Join-Path $root 'target/velopack/releases'

function Invoke-Step([string]$what, [scriptblock]$step) {
    # Windows PowerShell turns a tool's stderr (Tauri logs its progress
    # there) into a terminating error when output is redirected: the exit
    # code decides instead.
    $ErrorActionPreference = 'Continue'
    & $step
    if ($LASTEXITCODE -ne 0) { throw "$what failed." }
}

if (-not (Test-Path (Join-Path $root 'src-tauri/resources/microsoft/Quervio.MicrosoftBridge.exe'))) {
    throw 'The Microsoft bridge is missing: run scripts/build-microsoft.ps1 first.'
}

# A missing tool otherwise fails halfway through the build with a vague error.
$tools = @('dotnet', 'pnpm', 'cargo')
if ($Publish -and -not $Token) { $tools += 'gh' }
$missing = @($tools | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
if ($missing.Count -gt 0) {
    throw "Not found on PATH: $($missing -join ', '). Install them, then open a new terminal."
}

Push-Location $root
try {
    Invoke-Step 'vpk restore' { dotnet tool restore }
    # A fresh or older clone lacks node_modules, the Tauri CLI included.
    Invoke-Step 'pnpm install' { pnpm install --frozen-lockfile }
    Invoke-Step 'Tauri build' { pnpm tauri build --no-bundle }

    # The same layout as tauri.conf.json's bundle.resources, next to the exe:
    # on Windows Tauri's resource_dir() is the exe's folder.
    if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }
    New-Item -ItemType Directory $publishDir | Out-Null
    Copy-Item (Join-Path $root 'target/release/quervio.exe') $publishDir
    Copy-Item (Join-Path $root 'src-tauri/resources/microsoft') (Join-Path $publishDir 'microsoft') -Recurse
    Remove-Item (Join-Path $publishDir 'microsoft/README.txt') -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $root 'scripts/install-sqltools.ps1') $publishDir

    if ($Publish) {
        if (-not $Token) { $Token = gh auth token }
        if (-not $Token) { throw 'No GitHub token: run gh auth login or pass -Token.' }
        # The previous release, so vpk can build a delta package from it.
        Invoke-Step 'vpk download' { dotnet vpk download github -o $releasesDir --repoUrl $repo --token $Token }
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
        Invoke-Step 'vpk upload' {
            dotnet vpk upload github -o $releasesDir --repoUrl $repo --token $Token `
                --publish --releaseName "Quervio $version" --tag "v$version"
        }
    }
    Write-Host "Setup: $(Join-Path $releasesDir "$packId-win-Setup.exe")"
}
finally {
    Pop-Location
}
