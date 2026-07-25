param()

$ErrorActionPreference = 'Stop'

$Version = '0.69.0'
$ExpectedSha256 = '0e38f6dbe7761d648ca5c6ee323b7309544f48c01e9476f553902f3bc0949089'
$ArchiveName = "frp_${Version}_windows_amd64.zip"
$DownloadUrl = "https://github.com/fatedier/frp/releases/download/v${Version}/${ArchiveName}"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$DestinationDirectory = Join-Path $RepositoryRoot 'build\frp'
$TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("stone-frp-" + [guid]::NewGuid().ToString('N'))
$ArchivePath = Join-Path $TemporaryRoot $ArchiveName
$ExtractPath = Join-Path $TemporaryRoot 'extract'

New-Item -ItemType Directory -Path $TemporaryRoot,$ExtractPath,$DestinationDirectory -Force | Out-Null

Write-Host "Downloading official frpc v$Version..."
Invoke-WebRequest -Headers @{ 'User-Agent' = 'Stone-FRP-Bundler' } -Uri $DownloadUrl -OutFile $ArchivePath

$Sha256 = [Security.Cryptography.SHA256]::Create()
$ArchiveStream = [IO.File]::OpenRead($ArchivePath)
try {
  $ActualSha256 = (($Sha256.ComputeHash($ArchiveStream) | ForEach-Object { $_.ToString('x2') }) -join '')
} finally {
  $ArchiveStream.Dispose()
  $Sha256.Dispose()
}
if ($ActualSha256 -ne $ExpectedSha256) {
  throw "FRP archive checksum mismatch. Expected $ExpectedSha256 but received $ActualSha256."
}

Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractPath
$Executable = Get-ChildItem -LiteralPath $ExtractPath -Recurse -Filter 'frpc.exe' | Select-Object -First 1
$License = Get-ChildItem -LiteralPath $ExtractPath -Recurse -Filter 'LICENSE' | Select-Object -First 1
if (-not $Executable -or -not $License) { throw 'The official FRP archive is missing frpc.exe or LICENSE.' }

Copy-Item -LiteralPath $Executable.FullName -Destination (Join-Path $DestinationDirectory 'frpc.exe') -Force
Copy-Item -LiteralPath $License.FullName -Destination (Join-Path $DestinationDirectory 'LICENSE.frp.txt') -Force

Write-Host "frpc v$Version is ready in $DestinationDirectory"
