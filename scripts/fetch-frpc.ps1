param()

$ErrorActionPreference = 'Stop'

$Version = '0.69.0'
$ExpectedArchiveSize = 14182750
$ExpectedSha256 = '0e38f6dbe7761d648ca5c6ee323b7309544f48c01e9476f553902f3bc0949089'
$ExpectedExecutableSize = 16921088
$ExpectedExecutableSha256 = 'f8467a4f8d57cde5ba808a764b528147acd81db0955e51bee80fde0fea0e5243'
$ExpectedLicenseSize = 11358
$ExpectedLicenseSha256 = 'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'
$ArchiveName = "frp_${Version}_windows_amd64.zip"
$DownloadUrl = "https://github.com/fatedier/frp/releases/download/v${Version}/${ArchiveName}"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$DestinationDirectory = Join-Path $RepositoryRoot 'build\frp'
$TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("stone-frp-" + [guid]::NewGuid().ToString('N'))
$ArchivePath = Join-Path $TemporaryRoot $ArchiveName
$ExtractPath = Join-Path $TemporaryRoot 'extract'

function Get-Sha256([string] $Path) {
  $Sha256 = [Security.Cryptography.SHA256]::Create()
  $Stream = [IO.File]::OpenRead($Path)
  try {
    return (($Sha256.ComputeHash($Stream) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $Stream.Dispose()
    $Sha256.Dispose()
  }
}

function Assert-PinnedFile([System.IO.FileInfo] $File, [long] $ExpectedSize, [string] $ExpectedHash, [string] $Label) {
  if ($File.Length -ne $ExpectedSize) {
    throw "$Label size mismatch. Expected $ExpectedSize but received $($File.Length)."
  }
  $ActualHash = Get-Sha256 $File.FullName
  if ($ActualHash -ne $ExpectedHash) {
    throw "$Label checksum mismatch. Expected $ExpectedHash but received $ActualHash."
  }
}

try {
  New-Item -ItemType Directory -Path $TemporaryRoot,$ExtractPath,$DestinationDirectory -Force | Out-Null

  Write-Host "Downloading official frpc v$Version..."
  Invoke-WebRequest -Headers @{ 'User-Agent' = 'Stone-FRP-Bundler' } -Uri $DownloadUrl -OutFile $ArchivePath
  Assert-PinnedFile (Get-Item -LiteralPath $ArchivePath) $ExpectedArchiveSize $ExpectedSha256 'FRP archive'

  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractPath
  $Executables = @(Get-ChildItem -LiteralPath $ExtractPath -Recurse -File -Filter 'frpc.exe')
  $Licenses = @(Get-ChildItem -LiteralPath $ExtractPath -Recurse -File -Filter 'LICENSE')
  if ($Executables.Count -ne 1 -or $Licenses.Count -ne 1) {
    throw 'The official FRP archive must contain exactly one frpc.exe and one LICENSE.'
  }
  Assert-PinnedFile $Executables[0] $ExpectedExecutableSize $ExpectedExecutableSha256 'frpc.exe'
  Assert-PinnedFile $Licenses[0] $ExpectedLicenseSize $ExpectedLicenseSha256 'FRP license'

  Copy-Item -LiteralPath $Executables[0].FullName -Destination (Join-Path $DestinationDirectory 'frpc.exe') -Force
  Copy-Item -LiteralPath $Licenses[0].FullName -Destination (Join-Path $DestinationDirectory 'LICENSE.frp.txt') -Force
  & node (Join-Path $PSScriptRoot 'verify-frpc-runtime.mjs') --runtime-root $DestinationDirectory
  if ($LASTEXITCODE -ne 0) { throw "Pinned frpc runtime verification failed with exit code $LASTEXITCODE." }

  Write-Host "frpc v$Version is ready in $DestinationDirectory"
} finally {
  Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
