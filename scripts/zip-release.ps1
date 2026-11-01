# Build the two release zips for GitHub Releases.
#
#   SpriteFrameEditor-win64-app.zip    -> SpriteFrameEditor-win64/**  (exe / resources / pyshim, no data/)
#   SpriteFrameEditor-win64-models.zip -> SpriteFrameEditor-win64/data/models/*.onnx
#
# Extracting BOTH into the same folder yields one complete, runnable install.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/zip-release.ps1 windows-x64
#   or:   npm run zip:release
#
# Notes:
#   - Uses System.IO.Compression so entry paths can be controlled exactly
#     (Compress-Archive cannot add a top-level folder or exclude a subtree).
#   - onnx weights barely compress, so models.zip ends up close to the raw size.
param(
  [string]$Platform = 'windows-x64'
)

$ErrorActionPreference = 'Stop'
# Both assemblies are required: ZipArchiveMode / CompressionLevel live in
# System.IO.Compression, while ZipFile / ZipFileExtensions live in ...FileSystem.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
# -Encoding UTF8 is required: package.json contains Chinese text and PowerShell 5.1
# defaults to the system ANSI code page, which corrupts it and breaks ConvertFrom-Json.
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$productName = if ($pkg.productName) { $pkg.productName } else { 'app' }

$entryRoot = "$productName-win64"
$src = Join-Path $root "build\$Platform\$entryRoot"

if (-not (Test-Path $src)) {
  Write-Host "not found: $src" -ForegroundColor Red
  Write-Host "run 'npm run dist:win' first." -ForegroundColor Red
  exit 1
}

function New-ReleaseZip {
  param(
    [string]$ZipPath,
    [string]$SrcRoot,
    [string]$EntryPrefix,
    [scriptblock]$Include
  )
  if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
  Write-Host "packing $([System.IO.Path]::GetFileName($ZipPath)) ..."
  $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  $count = 0
  try {
    foreach ($file in (Get-ChildItem -Path $SrcRoot -Recurse -File)) {
      $rel = $file.FullName.Substring($SrcRoot.Length).TrimStart('\')
      if (-not $Include.Invoke($rel)) { continue }
      $entryName = $EntryPrefix + '/' + ($rel -replace '\\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
      $count++
    }
  } finally {
    $zip.Dispose()
  }
  Write-Host "  $count files"
}

# ---- app: everything except data/ ----
$appZip = Join-Path $root "build\$entryRoot-app.zip"
New-ReleaseZip -ZipPath $appZip -SrcRoot $src -EntryPrefix $entryRoot -Include {
  param($rel)
  -not ($rel -like 'data\*') -and -not ($rel -like 'data/*')
}

# ---- models: data/models only, keeps the data/models path inside the zip ----
$dataRoot = Join-Path $src 'data'
$modelsZip = Join-Path $root "build\$entryRoot-models.zip"
if (Test-Path $dataRoot) {
  New-ReleaseZip -ZipPath $modelsZip -SrcRoot $dataRoot -EntryPrefix "$entryRoot/data" -Include {
    param($rel) $true
  }
} else {
  Write-Host "warning: $dataRoot missing - models zip skipped" -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'release artifacts:'
Get-ChildItem (Join-Path $root 'build') -Filter '*.zip' | Sort-Object Name | ForEach-Object {
  Write-Host ("  {0,-42} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB))
}
Write-Host ''
Write-Host "upload both files to the GitHub release; they extract into the same folder."
