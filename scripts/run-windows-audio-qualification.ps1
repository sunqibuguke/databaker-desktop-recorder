$ErrorActionPreference = "Stop"
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$qualificationScript = Join-Path $PSScriptRoot "windows-audio-qualification.cjs"
if (-not (Test-Path -LiteralPath $qualificationScript -PathType Leaf)) {
    throw "Qualification script not found: $qualificationScript"
}

# Installed packages reuse Electron as a Node host so qualification does not
# require a separate Node.js installation on the studio workstation.
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
        & $electronHost.FullName $qualificationScript @args | Out-Host
        $qualificationExitCode = $LASTEXITCODE
        exit $qualificationExitCode
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

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    throw "Node.js was not found. In a source checkout install Node.js 22+, or run this script from the packaged resources\acceptance directory."
}
& $nodeCommand.Source $qualificationScript @args
exit $LASTEXITCODE
