param([string]$Initial = "C:\")

$csPath = Join-Path $PSScriptRoot "FolderPick.cs"
try { $null = [FolderPick] } catch {
  try { Add-Type -Path $csPath } catch { }
}

try {
  $p = [FolderPick]::Pick($Initial)
  if ($p) { Write-Output $p; exit 0 }
} catch { }

try {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  try { $d.SelectedPath = $Initial } catch { }
  if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
} catch { }

exit 0