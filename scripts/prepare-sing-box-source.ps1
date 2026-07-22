[CmdletBinding()]
param(
  [string] $DestinationRoot,
  [switch] $SkipArchive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$DistributionManifestPath = Join-Path $RepositoryRoot 'build\sing-box\distribution-manifest.json'
$DistributionManifest = Get-Content -LiteralPath $DistributionManifestPath -Raw | ConvertFrom-Json
if ($DistributionManifest.schemaVersion -ne 1 -or $DistributionManifest.version -ne '1.13.14') {
  throw 'The corresponding-source recipe only supports the pinned sing-box v1.13.14 manifest.'
}

if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
  $DestinationRoot = Join-Path $RepositoryRoot 'release\sources'
}
$DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot)
New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

$StoneVersion = (Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json).version
$SourceName = "StonePlus-$StoneVersion-sing-box-$($DistributionManifest.version)-corresponding-source"
$FinalSourceRoot = Join-Path $DestinationRoot $SourceName
$FinalArchive = Join-Path $DestinationRoot "$SourceName.tar.gz"
if (Test-Path -LiteralPath $FinalSourceRoot) {
  throw "Refusing to overwrite existing corresponding source: $FinalSourceRoot"
}
if (-not $SkipArchive -and (Test-Path -LiteralPath $FinalArchive)) {
  throw "Refusing to overwrite existing corresponding-source archive: $FinalArchive"
}

$StagingRoot = Join-Path $DestinationRoot ('.sb-src-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$PayloadRoot = Join-Path $StagingRoot $SourceName

function Invoke-CheckedTool {
  param(
    [Parameter(Mandatory)][string] $FilePath,
    [Parameter(Mandatory)][string[]] $Arguments,
    [Parameter(Mandatory)][string] $FailureMessage
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code $LASTEXITCODE)."
  }
}

function Checkout-PinnedRepository {
  param(
    [Parameter(Mandatory)][string] $Url,
    [Parameter(Mandatory)][string] $Commit,
    [Parameter(Mandatory)][string] $Path
  )

  New-Item -ItemType Directory -Path $Path | Out-Null
  $GitPrefix = @('-c', 'core.longpaths=true', '-C', $Path)
  Invoke-CheckedTool -FilePath 'git' -Arguments @($GitPrefix + @('init', '--quiet')) -FailureMessage "Unable to initialize $Url"
  Invoke-CheckedTool -FilePath 'git' -Arguments @($GitPrefix + @('remote', 'add', 'origin', $Url)) -FailureMessage "Unable to add remote $Url"
  Invoke-CheckedTool -FilePath 'git' -Arguments @($GitPrefix + @('fetch', '--depth=1', 'origin', $Commit)) -FailureMessage "Unable to fetch $Url at $Commit"
  Invoke-CheckedTool -FilePath 'git' -Arguments @($GitPrefix + @('checkout', '--quiet', '--detach', 'FETCH_HEAD')) -FailureMessage "Unable to check out $Url at $Commit"
  $ActualCommit = (& git -c core.longpaths=true -C $Path rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $ActualCommit -cne $Commit) {
    throw "Repository checkout mismatch for $Url. Expected $Commit, received $ActualCommit."
  }
}

function Invoke-GoVendor {
  param([Parameter(Mandatory)][string] $Path)

  Push-Location $Path
  try {
    Invoke-CheckedTool -FilePath 'go' -Arguments @('mod', 'vendor') -FailureMessage "Unable to vendor Go module source in $Path"
  } finally {
    Pop-Location
  }
}

function Remove-GitMetadata {
  param([Parameter(Mandatory)][string] $Path)

  $MetadataPath = Join-Path $Path '.git'
  if (Test-Path -LiteralPath $MetadataPath) {
    Remove-Item -LiteralPath $MetadataPath -Recurse -Force
  }
}

try {
  New-Item -ItemType Directory -Path $PayloadRoot | Out-Null

  $SingBoxSource = Join-Path $PayloadRoot 'sing-box'
  Checkout-PinnedRepository -Url $DistributionManifest.upstream.repository -Commit $DistributionManifest.upstream.commit -Path $SingBoxSource
  Invoke-GoVendor -Path $SingBoxSource

  $CronetSource = Join-Path $PayloadRoot 'cronet-go'
  Checkout-PinnedRepository -Url 'https://github.com/SagerNet/cronet-go' -Commit $DistributionManifest.upstream.cronetGoCommit -Path $CronetSource
  Invoke-CheckedTool -FilePath 'git' -Arguments @('-c', 'core.longpaths=true', '-C', $CronetSource, 'submodule', 'update', '--init', '--recursive', '--depth=1') -FailureMessage 'Unable to fetch pinned cronet-go submodule source'
  $PinnedNaiveProxy = ((& git -c core.longpaths=true -C $CronetSource ls-tree HEAD naiveproxy) -split '\s+')[2]
  if ($LASTEXITCODE -ne 0 -or $PinnedNaiveProxy -cne $DistributionManifest.upstream.naiveProxyCommit) {
    throw "cronet-go pins unexpected NaiveProxy source: $PinnedNaiveProxy"
  }
  Invoke-GoVendor -Path $CronetSource

  $IntegrationRoot = Join-Path $PayloadRoot 'stone-integration'
  New-Item -ItemType Directory -Path $IntegrationRoot | Out-Null
  foreach ($RelativePath in @(
    'package.json',
    'THIRD_PARTY_NOTICES.md',
    'SOURCE_OFFER-sing-box.md',
    'docs\distribution-compliance.md',
    'build\sing-box\distribution-manifest.json',
    'build\sing-box\runtime-manifest.json',
    'scripts\fetch-sing-box.ps1',
    'scripts\verify-sing-box-runtime.mjs',
    'scripts\electron-builder-before-pack.mjs',
    'scripts\prepare-sing-box-source.ps1'
  )) {
    $SourcePath = Join-Path $RepositoryRoot $RelativePath
    $DestinationPath = Join-Path $IntegrationRoot $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $DestinationPath) -Force | Out-Null
    Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath
  }
  Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'LICENSES') -Destination (Join-Path $IntegrationRoot 'LICENSES') -Recurse

  $Metadata = [ordered]@{
    schemaVersion = 1
    stoneVersion = $StoneVersion
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    singBoxVersion = $DistributionManifest.version
    singBoxCommit = $DistributionManifest.upstream.commit
    cronetGoCommit = $DistributionManifest.upstream.cronetGoCommit
    naiveProxyCommit = $DistributionManifest.upstream.naiveProxyCommit
    preparationCommand = 'npm run sing-box:source'
  } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $PayloadRoot 'BUILD-METADATA.json'), "$Metadata`n", [Text.UTF8Encoding]::new($false))

  Remove-GitMetadata -Path $SingBoxSource
  Remove-GitMetadata -Path $CronetSource
  Remove-GitMetadata -Path (Join-Path $CronetSource 'naiveproxy')

  $ChecksumLines = @(Get-ChildItem -LiteralPath $PayloadRoot -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
    $RelativePath = [IO.Path]::GetRelativePath($PayloadRoot, $_.FullName).Replace('\', '/')
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    "$Hash  $RelativePath"
  })
  [IO.File]::WriteAllLines((Join-Path $PayloadRoot 'SOURCE-MANIFEST.sha256'), $ChecksumLines, [Text.UTF8Encoding]::new($false))

  Move-Item -LiteralPath $PayloadRoot -Destination $FinalSourceRoot
  if (-not $SkipArchive) {
    Invoke-CheckedTool -FilePath 'tar' -Arguments @('-czf', $FinalArchive, '-C', $DestinationRoot, $SourceName) -FailureMessage 'Unable to create corresponding-source archive'
    $ArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $FinalArchive).Hash.ToLowerInvariant()
    Write-Host "Corresponding-source archive: $FinalArchive"
    Write-Host "SHA-256: $ArchiveHash"
  } else {
    Write-Host "Corresponding source directory: $FinalSourceRoot"
  }
} finally {
  if (Test-Path -LiteralPath $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
  }
}
