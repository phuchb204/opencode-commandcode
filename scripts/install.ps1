param(
  [string]$Destination = "$env:USERPROFILE\.config\opencode\opencode-commandcode",
  [switch]$KeepLegacyProvider
)

$ErrorActionPreference = "Stop"
$repository = "https://github.com/phuchb204/opencode-commandcode.git"

if (Test-Path (Join-Path $Destination ".git")) {
  Write-Host "Updating $Destination"
  git -C $Destination pull --ff-only
} else {
  $parent = Split-Path -Parent $Destination
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Write-Host "Cloning into $Destination"
  git clone $repository $Destination
}

$keep = if ($KeepLegacyProvider) { "true" } else { "false" }
node (Join-Path $Destination "scripts\register.mjs") $Destination $keep
Write-Host "Done. Restart OpenCode Desktop and open Settings > Command Code."
