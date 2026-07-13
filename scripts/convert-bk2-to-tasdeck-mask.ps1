[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $FirstPath,

    [Parameter(Position = 1)]
    [string] $SecondPath,

    [Parameter(Position = 2)]
    [string] $OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-Usage {
    @"
Usage:
  .\scripts\convert-bk2-to-tasdeck-mask.ps1 <movie.bk2> <rom.nes> [output.tdmask]
  .\scripts\convert-bk2-to-tasdeck-mask.ps1 <rom.nes> <movie.bk2> [output.tdmask]

Environment:
  BIZHAWK_BIN=C:\path\to\EmuHawk.exe   Override the BizHawk executable for .bk2 input.
  TASDECK_MASK_TRACE_OUTPUT=path.csv     Override the trace CSV path.

Output:
  Defaults to the current working directory, with the movie base name and a
  .tdmask extension.
"@ | Write-Host
}

function Get-FullPath([string] $Path) {
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-InputFile([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label file not found: $Path"
    }
}

function Assert-DistinctPath([string] $Candidate, [string[]] $Inputs, [string] $Message) {
    foreach ($inputPath in $Inputs) {
        if ([string]::Equals($Candidate, $inputPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw $Message
        }
    }
}

function Find-BizHawk {
    if (-not [string]::IsNullOrWhiteSpace($env:BIZHAWK_BIN)) {
        return Get-FullPath $env:BIZHAWK_BIN
    }

    $command = Get-Command EmuHawk.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $localCandidates = @(
        (Join-Path (Get-Location) "EmuHawk.exe"),
        (Join-Path (Split-Path -Parent $PSScriptRoot) "EmuHawk.exe")
    )
    foreach ($candidate in $localCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return Get-FullPath $candidate
        }
    }

    throw "Could not find EmuHawk.exe. Set BIZHAWK_BIN=C:\path\to\EmuHawk.exe."
}

if ($FirstPath -in @("-h", "--help", "/?")) {
    Show-Usage
    exit 0
}

if ([string]::IsNullOrWhiteSpace($FirstPath) -or
    [string]::IsNullOrWhiteSpace($SecondPath)) {
    Show-Usage
    exit 2
}

$firstExtension = [System.IO.Path]::GetExtension($FirstPath).ToLowerInvariant()
$secondExtension = [System.IO.Path]::GetExtension($SecondPath).ToLowerInvariant()

if ($firstExtension -eq ".bk2") {
    $movieArgument = $FirstPath
    $romArgument = $SecondPath
} elseif ($secondExtension -eq ".bk2") {
    $movieArgument = $SecondPath
    $romArgument = $FirstPath
} else {
    Show-Usage
    throw "One input must have a .bk2 extension. Use convert-r08-to-tasdeck-mask.sh for .r08 input."
}

Assert-InputFile $movieArgument "Movie"
Assert-InputFile $romArgument "ROM"
$moviePath = (Resolve-Path -LiteralPath $movieArgument).ProviderPath
$romPath = (Resolve-Path -LiteralPath $romArgument).ProviderPath
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $movieName = [System.IO.Path]::GetFileNameWithoutExtension($moviePath)
    $OutputPath = Join-Path (Get-Location) "$movieName.tdmask"
}
$outputFullPath = Get-FullPath $OutputPath

if ([string]::IsNullOrWhiteSpace($env:TASDECK_MASK_TRACE_OUTPUT)) {
    $traceFullPath = "$outputFullPath.trace.csv"
} else {
    $traceFullPath = Get-FullPath $env:TASDECK_MASK_TRACE_OUTPUT
}

Assert-DistinctPath $outputFullPath @($moviePath, $romPath) "Output path must not overwrite the movie or ROM file."
Assert-DistinctPath $traceFullPath @($moviePath, $romPath, $outputFullPath) "Trace path must not overwrite an input or the .tdmask output."

[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($outputFullPath)) | Out-Null
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($traceFullPath)) | Out-Null
Remove-Item -LiteralPath $outputFullPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $traceFullPath -Force -ErrorAction SilentlyContinue

Write-Host ("Movie:   {0}" -f $moviePath)
Write-Host ("ROM:     {0}" -f $romPath)
Write-Host ("Output:  {0}" -f $outputFullPath)
Write-Host ("Trace:   {0}" -f $traceFullPath)

$bizHawkPath = Find-BizHawk
Assert-InputFile $bizHawkPath "BizHawk executable"
$luaPath = Join-Path $PSScriptRoot "bizhawk-export-tasdeck-mask.lua"
Assert-InputFile $luaPath "BizHawk Lua exporter"
$completionPath = Join-Path ([System.IO.Path]::GetTempPath()) ("tasdeck-mask-complete-{0}.txt" -f [guid]::NewGuid())

Write-Host ("BizHawk: {0}" -f $bizHawkPath)

$oldOutput = $env:TASDECK_MASK_OUTPUT
$oldTrace = $env:TASDECK_MASK_TRACE_OUTPUT
$oldCompletion = $env:TASDECK_MASK_COMPLETION_OUTPUT
try {
    $env:TASDECK_MASK_OUTPUT = $outputFullPath
    $env:TASDECK_MASK_TRACE_OUTPUT = $traceFullPath
    $env:TASDECK_MASK_COMPLETION_OUTPUT = $completionPath

    & $bizHawkPath "--lua=$luaPath" "--movie=$moviePath" $romPath
    $bizHawkStatus = $LASTEXITCODE

    if (-not (Test-Path -LiteralPath $completionPath -PathType Leaf)) {
        throw "BizHawk did not report a completed TASDeck export (exit $bizHawkStatus)."
    }

    $completion = (Get-Content -LiteralPath $completionPath -Raw).Trim()
    if (-not $completion.StartsWith("complete ")) {
        throw "BizHawk exporter failed: $completion"
    }
    if ($bizHawkStatus -ne 0) {
        Write-Warning "BizHawk exited with status $bizHawkStatus after completing the export; validating outputs."
    }
    if ($completion -match "(?:reset_frames|power_frames)=[1-9]") {
        Write-Warning "The BK2 contains Reset or Power commands. TD2P stores controller masks only; reproduce those console actions separately on hardware."
    }
    Write-Host $completion
}
finally {
    $env:TASDECK_MASK_OUTPUT = $oldOutput
    $env:TASDECK_MASK_TRACE_OUTPUT = $oldTrace
    $env:TASDECK_MASK_COMPLETION_OUTPUT = $oldCompletion
    Remove-Item -LiteralPath $completionPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $outputFullPath -PathType Leaf)) {
    throw "Conversion did not create an output file: $outputFullPath"
}

[byte[]] $outputBytes = [System.IO.File]::ReadAllBytes($outputFullPath)
[byte[]] $expectedHeader = 0x54, 0x44, 0x32, 0x50, 0x01, 0x02, 0x0D, 0x0A
if ($outputBytes.Length -lt $expectedHeader.Length) {
    throw "Output is too short to contain a TD2P v1 header: $outputFullPath"
}
for ($index = 0; $index -lt $expectedHeader.Length; $index += 1) {
    if ($outputBytes[$index] -ne $expectedHeader[$index]) {
        throw "Output does not contain a supported TD2P v1 header: $outputFullPath"
    }
}
if ((($outputBytes.Length - $expectedHeader.Length) % 2) -ne 0) {
    throw "Output has an incomplete two-controller frame: $outputFullPath"
}

$frameCount = [int] (($outputBytes.Length - $expectedHeader.Length) / 2)
Write-Host ("Wrote {0} byte(s), {1} polled frame(s): {2}" -f $outputBytes.Length, $frameCount, $outputFullPath)
if (Test-Path -LiteralPath $traceFullPath -PathType Leaf) {
    $traceRows = ([System.IO.File]::ReadLines($traceFullPath) | Measure-Object).Count
    Write-Host ("Wrote trace CSV with {0} line(s): {1}" -f $traceRows, $traceFullPath)
}
