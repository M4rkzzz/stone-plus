param([Parameter(Mandatory = $true)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
[System.IO.File]::WriteAllText($OutputPath, 'powershell-shim-launched')
