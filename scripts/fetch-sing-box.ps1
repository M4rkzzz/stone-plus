[CmdletBinding()]
param(
  [ValidateSet('win-x64', 'linux-x64', 'linux-arm64', 'mac-x64', 'mac-arm64')]
  [string[]] $Target = @('win-x64', 'linux-x64', 'linux-arm64', 'mac-x64', 'mac-arm64'),
  [switch] $VerifyOnly,
  [string] $DestinationRoot,
  [string] $ArchiveCache
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$ManifestRoot = Join-Path $RepositoryRoot 'build\sing-box'
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
  $DestinationRoot = $ManifestRoot
}
$DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot)

$DistributionManifest = Get-Content -LiteralPath (Join-Path $ManifestRoot 'distribution-manifest.json') -Raw | ConvertFrom-Json
$RuntimeManifest = Get-Content -LiteralPath (Join-Path $ManifestRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json

if ($DistributionManifest.schemaVersion -ne 1 -or $RuntimeManifest.schemaVersion -ne 1) {
  throw 'Unsupported sing-box manifest schema.'
}
if ($DistributionManifest.version -ne '1.13.14' -or $RuntimeManifest.version -ne '1.13.14') {
  throw 'The sing-box build input must remain pinned to v1.13.14.'
}

function Get-Sha256 {
  param([Parameter(Mandatory)][string] $Path)

  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function ConvertTo-PortableRelativePath {
  param(
    [Parameter(Mandatory)][string] $Root,
    [Parameter(Mandatory)][string] $Path
  )

  return [IO.Path]::GetRelativePath($Root, $Path).Replace('\', '/')
}

function Assert-SafeRelativePath {
  param([Parameter(Mandatory)][string] $Path)

  $PortablePath = $Path.Replace('\', '/').TrimEnd('/')
  if ([string]::IsNullOrWhiteSpace($PortablePath)) {
    return
  }
  if ($PortablePath.StartsWith('/') -or $PortablePath -match '^[A-Za-z]:' -or $PortablePath.StartsWith('//')) {
    throw "Archive contains an absolute path: $Path"
  }
  foreach ($Segment in $PortablePath.Split('/')) {
    if ($Segment -eq '..' -or $Segment -eq '.') {
      throw "Archive contains an unsafe path segment: $Path"
    }
  }
}

function Assert-ArchivePaths {
  param([Parameter(Mandatory)][string] $ArchivePath)

  if ($ArchivePath.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
      foreach ($Entry in $Zip.Entries) {
        Assert-SafeRelativePath -Path $Entry.FullName
      }
    } finally {
      $Zip.Dispose()
    }
    return
  }

  $Entries = @(& tar -tzf $ArchivePath)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect tar archive $ArchivePath."
  }
  foreach ($Entry in $Entries) {
    Assert-SafeRelativePath -Path $Entry
  }
}

function Assert-RuntimeDirectory {
  param(
    [Parameter(Mandatory)][string] $RuntimeRoot,
    [Parameter(Mandatory)][string] $TargetName,
    [Parameter(Mandatory)] $TargetManifest
  )

  if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
    throw "sing-box runtime '$TargetName' is missing at $RuntimeRoot."
  }

  $UnsafeEntries = @(Get-ChildItem -LiteralPath $RuntimeRoot -Force -Recurse | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($UnsafeEntries.Count -gt 0) {
    throw "sing-box runtime '$TargetName' contains a symbolic link or reparse point: $($UnsafeEntries[0].FullName)"
  }

  $ExpectedFiles = @{}
  foreach ($Expected in @($TargetManifest.files)) {
    Assert-SafeRelativePath -Path $Expected.path
    if ($ExpectedFiles.ContainsKey($Expected.path)) {
      throw "Duplicate file in runtime manifest for '$TargetName': $($Expected.path)"
    }
    $ExpectedFiles[$Expected.path] = $Expected
  }

  $ActualFiles = @(Get-ChildItem -LiteralPath $RuntimeRoot -Force -Recurse -File)
  if ($ActualFiles.Count -ne $ExpectedFiles.Count) {
    throw "sing-box runtime '$TargetName' has $($ActualFiles.Count) files; expected $($ExpectedFiles.Count)."
  }

  foreach ($Actual in $ActualFiles) {
    $RelativePath = ConvertTo-PortableRelativePath -Root $RuntimeRoot -Path $Actual.FullName
    if (-not $ExpectedFiles.ContainsKey($RelativePath)) {
      throw "Unexpected file in sing-box runtime '$TargetName': $RelativePath"
    }
    $Expected = $ExpectedFiles[$RelativePath]
    if ([int64] $Actual.Length -ne [int64] $Expected.size) {
      throw "Size mismatch for sing-box runtime file '$TargetName/$RelativePath'."
    }
    $ActualHash = Get-Sha256 -Path $Actual.FullName
    if ($ActualHash -cne [string] $Expected.sha256) {
      throw "SHA-256 mismatch for sing-box runtime file '$TargetName/$RelativePath'."
    }
  }

  $RequiredPaths = @($TargetManifest.executable)
  $CronetProperty = $TargetManifest.PSObject.Properties['cronetLibrary']
  if ($null -ne $CronetProperty) {
    $RequiredPaths += $CronetProperty.Value
  }
  foreach ($RequiredPath in $RequiredPaths) {
    if ([string]::IsNullOrWhiteSpace($RequiredPath)) {
      continue
    }
    if (-not $ExpectedFiles.ContainsKey($RequiredPath)) {
      throw "Required runtime file '$RequiredPath' is not protected by the '$TargetName' manifest."
    }
  }
}

function Install-RuntimeTarget {
  param([Parameter(Mandatory)][string] $TargetName)

  $DistributionTarget = $DistributionManifest.targets.PSObject.Properties[$TargetName].Value
  $RuntimeTarget = $RuntimeManifest.targets.PSObject.Properties[$TargetName].Value
  if ($null -eq $DistributionTarget -or $null -eq $RuntimeTarget) {
    throw "Unknown sing-box target '$TargetName'."
  }
  if ($RuntimeTarget.runtimeDirectory -cne $TargetName) {
    throw "Runtime directory for '$TargetName' must exactly match the target name."
  }

  $Archive = $DistributionTarget.archive
  $DownloadUri = [Uri] $Archive.url
  $ExpectedPrefix = "/SagerNet/sing-box/releases/download/v$($DistributionManifest.version)/"
  if ($DownloadUri.Scheme -cne 'https' -or $DownloadUri.Host -cne 'github.com' -or
      -not $DownloadUri.AbsolutePath.StartsWith($ExpectedPrefix, [StringComparison]::Ordinal)) {
    throw "Refusing non-official sing-box download URL for '$TargetName'."
  }
  if ([IO.Path]::GetFileName($DownloadUri.AbsolutePath) -cne [string] $Archive.name) {
    throw "Archive name and URL disagree for '$TargetName'."
  }

  $TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("stone-sing-box-$TargetName-" + [guid]::NewGuid().ToString('N'))
  $ArchivePath = Join-Path $TemporaryRoot $Archive.name
  $ExtractRoot = Join-Path $TemporaryRoot 'extract'
  New-Item -ItemType Directory -Path $TemporaryRoot, $ExtractRoot -Force | Out-Null
  try {
    $CachedArchive = if ([string]::IsNullOrWhiteSpace($ArchiveCache)) {
      $null
    } else {
      Join-Path ([IO.Path]::GetFullPath($ArchiveCache)) $Archive.name
    }
    if ($null -ne $CachedArchive -and (Test-Path -LiteralPath $CachedArchive -PathType Leaf)) {
      Write-Host "Using cached sing-box v$($DistributionManifest.version) archive for $TargetName..."
      Copy-Item -LiteralPath $CachedArchive -Destination $ArchivePath
    } else {
      Write-Host "Downloading verified sing-box v$($DistributionManifest.version) runtime for $TargetName..."
      Invoke-WebRequest -Headers @{ 'User-Agent' = 'StonePlus-sing-box-fetcher' } -Uri $DownloadUri -OutFile $ArchivePath
    }

    $DownloadedArchive = Get-Item -LiteralPath $ArchivePath
    if ([int64] $DownloadedArchive.Length -ne [int64] $Archive.size) {
      throw "Archive size mismatch for '$TargetName'."
    }
    $ActualArchiveHash = Get-Sha256 -Path $ArchivePath
    if ($ActualArchiveHash -cne [string] $Archive.sha256) {
      throw "Archive SHA-256 mismatch for '$TargetName'. Expected $($Archive.sha256), received $ActualArchiveHash."
    }
    if ($null -ne $CachedArchive -and -not (Test-Path -LiteralPath $CachedArchive)) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $CachedArchive) -Force | Out-Null
      Copy-Item -LiteralPath $ArchivePath -Destination $CachedArchive
    }

    Assert-ArchivePaths -ArchivePath $ArchivePath
    if ($Archive.name.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
      Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot
    } else {
      & tar -xzf $ArchivePath -C $ExtractRoot
      if ($LASTEXITCODE -ne 0) {
        throw "Unable to extract sing-box archive for '$TargetName'."
      }
    }

    $ArchiveRoots = @(Get-ChildItem -LiteralPath $ExtractRoot -Force)
    if ($ArchiveRoots.Count -ne 1 -or -not $ArchiveRoots[0].PSIsContainer) {
      throw "Unexpected top-level layout in sing-box archive for '$TargetName'."
    }
    Assert-RuntimeDirectory -RuntimeRoot $ArchiveRoots[0].FullName -TargetName $TargetName -TargetManifest $RuntimeTarget

    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    $StagingPath = Join-Path $DestinationRoot (".$TargetName.staging-" + [guid]::NewGuid().ToString('N'))
    $BackupPath = Join-Path $DestinationRoot (".$TargetName.backup-" + [guid]::NewGuid().ToString('N'))
    $DestinationPath = Join-Path $DestinationRoot $TargetName
    New-Item -ItemType Directory -Path $StagingPath | Out-Null
    try {
      foreach ($Item in Get-ChildItem -LiteralPath $ArchiveRoots[0].FullName -Force) {
        Copy-Item -LiteralPath $Item.FullName -Destination $StagingPath -Recurse
      }
      if (-not $IsWindows) {
        & chmod 755 (Join-Path $StagingPath $RuntimeTarget.executable)
        if ($LASTEXITCODE -ne 0) {
          throw "Unable to mark the $TargetName sing-box binary executable."
        }
      }
      Assert-RuntimeDirectory -RuntimeRoot $StagingPath -TargetName $TargetName -TargetManifest $RuntimeTarget

      $HadPreviousRuntime = Test-Path -LiteralPath $DestinationPath
      if ($HadPreviousRuntime) {
        Move-Item -LiteralPath $DestinationPath -Destination $BackupPath
      }
      try {
        Move-Item -LiteralPath $StagingPath -Destination $DestinationPath
        Assert-RuntimeDirectory -RuntimeRoot $DestinationPath -TargetName $TargetName -TargetManifest $RuntimeTarget
      } catch {
        if (Test-Path -LiteralPath $DestinationPath) {
          Remove-Item -LiteralPath $DestinationPath -Recurse -Force
        }
        if ($HadPreviousRuntime -and (Test-Path -LiteralPath $BackupPath)) {
          Move-Item -LiteralPath $BackupPath -Destination $DestinationPath
        }
        throw
      }
      if (Test-Path -LiteralPath $BackupPath) {
        Remove-Item -LiteralPath $BackupPath -Recurse -Force
      }
    } finally {
      if (Test-Path -LiteralPath $StagingPath) {
        Remove-Item -LiteralPath $StagingPath -Recurse -Force
      }
      if (Test-Path -LiteralPath $BackupPath) {
        throw "A previous '$TargetName' runtime remains at $BackupPath after an incomplete update."
      }
    }

    Write-Host "sing-box $TargetName is verified and ready at $DestinationPath"
  } finally {
    if (Test-Path -LiteralPath $TemporaryRoot) {
      Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
    }
  }
}

foreach ($TargetName in $Target) {
  $RuntimeTarget = $RuntimeManifest.targets.PSObject.Properties[$TargetName].Value
  if ($null -eq $RuntimeTarget) {
    throw "Unknown sing-box target '$TargetName'."
  }
  $RuntimePath = Join-Path $DestinationRoot $RuntimeTarget.runtimeDirectory
  if ($VerifyOnly) {
    Assert-RuntimeDirectory -RuntimeRoot $RuntimePath -TargetName $TargetName -TargetManifest $RuntimeTarget
    Write-Host "sing-box $TargetName runtime verified."
  } else {
    Install-RuntimeTarget -TargetName $TargetName
  }
}
