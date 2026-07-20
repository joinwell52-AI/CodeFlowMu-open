Add-Type -AssemblyName System.Windows.Forms

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Select Windows application"
$dialog.Filter = "Windows applications (*.exe)|*.exe"
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.Multiselect = $false

$initial = $env:CFM_PICK_INITIAL
if ($initial) {
  if (Test-Path -LiteralPath $initial -PathType Leaf) {
    $dialog.InitialDirectory = [System.IO.Path]::GetDirectoryName($initial)
    $dialog.FileName = [System.IO.Path]::GetFileName($initial)
  } elseif (Test-Path -LiteralPath $initial -PathType Container) {
    $dialog.InitialDirectory = $initial
  }
}

$owner = New-Object System.Windows.Forms.Form
$owner.Text = "CodeFlowMu"
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
$owner.Show()
$owner.Activate()

$dialogResult = $dialog.ShowDialog($owner)
$owner.Close()
$owner.Dispose()

if ($dialogResult -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($dialog.FileName)
  [ordered]@{
    path = $dialog.FileName
    productName = $info.ProductName
    fileDescription = $info.FileDescription
    companyName = $info.CompanyName
    fileVersion = $info.FileVersion
  } | ConvertTo-Json -Compress
} else {
  Write-Output "__CANCELLED__"
}
