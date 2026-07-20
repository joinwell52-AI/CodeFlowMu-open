# Native folder picker for CodeFlowMu Panel (Windows).
# Initial path via env CFM_PICK_INITIAL; stdout is selected path or __CANCELLED__.
param()
$initial = $env:CFM_PICK_INITIAL
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select product development root folder"
$dialog.ShowNewFolderButton = $true
if ($initial -and (Test-Path -LiteralPath $initial)) {
  $dialog.SelectedPath = $initial
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
} else {
  Write-Output "__CANCELLED__"
}
