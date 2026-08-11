$ErrorActionPreference = "Stop"
# The acceptance tool deliberately uses 0/1/2 as PASS/FAIL/INCOMPLETE. In
# PowerShell 7, an inherited native-error preference must not turn 1 or 2 into a
# terminating PowerShell error before we can propagate the exact exit code.
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$acceptanceScript = Join-Path $PSScriptRoot "windows-audio-acceptance.cjs"
if (-not (Test-Path -LiteralPath $acceptanceScript -PathType Leaf)) {
    throw "Acceptance script not found: $acceptanceScript"
}

# In an installed/unpacked Electron build this directory is
# resources\acceptance and the native engine is resources\bin. Reuse the
# packaged Electron executable as a Node host so customer machines do not need
# a separate Node.js installation.
$resourcesDirectory = Split-Path $PSScriptRoot -Parent
$packagedEngine = Join-Path $resourcesDirectory "bin\recorder-engine.exe"
if (Test-Path -LiteralPath $packagedEngine -PathType Leaf) {
    $installDirectory = Split-Path $resourcesDirectory -Parent
    $electronHost = Get-ChildItem -LiteralPath $installDirectory -Filter "*.exe" -File |
        Where-Object { $_.Name -notmatch "(?i)unins|uninstall|update" } |
        Select-Object -First 1
    if ($null -eq $electronHost) {
        throw "Could not locate the packaged DataBaker Electron executable in $installDirectory"
    }

    $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = "1"
        # Electron is a Windows GUI-subsystem executable even in Node mode.
        # PowerShell may return immediately when such an executable is the last
        # pipeline command. Routing stdout through Out-Host makes it a pipeline
        # producer, which keeps PowerShell attached until the process exits while
        # preserving the original argv values (including paths with spaces).
        & $electronHost.FullName $acceptanceScript @args | Out-Host
        $acceptanceExitCode = $LASTEXITCODE
        exit $acceptanceExitCode
    }
    finally {
        if ($null -eq $previousRunAsNode) {
            Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        }
        else {
            $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
        }
    }
}

# Source checkout fallback.
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    throw "Node.js was not found. In a source checkout install Node.js 22+, or run this script from the packaged resources\acceptance directory."
}
& $nodeCommand.Source $acceptanceScript @args
exit $LASTEXITCODE
