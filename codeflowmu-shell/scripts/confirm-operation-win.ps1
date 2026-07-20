$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$title = [Environment]::GetEnvironmentVariable("CFM_CONFIRM_TITLE")
$message = [Environment]::GetEnvironmentVariable("CFM_CONFIRM_MESSAGE")
$smoke = [Environment]::GetEnvironmentVariable("CFM_CONFIRM_SMOKE")

$defaultTitle = "CodeFlowMu " + (-join ([char[]](0x5B89, 0x5168, 0x786E, 0x8BA4)))
$defaultMessage = -join ([char[]](0x8BF7, 0x786E, 0x8BA4, 0x662F, 0x5426, 0x7EE7, 0x7EED, 0x6267, 0x884C, 0x5F53, 0x524D, 0x64CD, 0x4F5C, 0x3002))
if ([string]::IsNullOrWhiteSpace($title)) { $title = $defaultTitle }
if ([string]::IsNullOrWhiteSpace($message)) { $message = $defaultMessage }

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="620" Height="560" WindowStartupLocation="CenterScreen"
        WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="True"
        Background="Transparent" ShowInTaskbar="True" Topmost="True"
        FontFamily="Segoe UI, Microsoft YaHei UI" Foreground="#E6EDF3">
  <Window.Resources>
    <Style x:Key="ActionButton" TargetType="Button">
      <Setter Property="Height" Value="42"/>
      <Setter Property="MinWidth" Value="112"/>
      <Setter Property="Padding" Value="22,0"/>
      <Setter Property="Margin" Value="10,0,0,0"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="ButtonBorder" CornerRadius="8"
                    Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="ButtonBorder" Property="Opacity" Value="0.88"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="ButtonBorder" Property="Opacity" Value="0.72"/>
              </Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True">
                <Setter TargetName="ButtonBorder" Property="BorderBrush" Value="#79C0FF"/>
                <Setter TargetName="ButtonBorder" Property="BorderThickness" Value="2"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Border CornerRadius="14" Background="#0D1524" BorderBrush="#26354D" BorderThickness="1">
    <Border.Effect>
      <DropShadowEffect Color="#000000" BlurRadius="30" ShadowDepth="8" Opacity="0.48"/>
    </Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="56"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="1"/>
        <RowDefinition Height="76"/>
      </Grid.RowDefinitions>

      <Grid x:Name="DragArea" Grid.Row="0" Background="Transparent">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="56"/>
        </Grid.ColumnDefinitions>
        <Border Width="28" Height="28" Margin="18,0,10,0" CornerRadius="7" Background="#1F6FEB">
          <TextBlock Text="C" FontSize="15" FontWeight="Bold" Foreground="White"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <StackPanel Grid.Column="1" VerticalAlignment="Center">
          <TextBlock Text="CODEFLOWMU" FontSize="10" FontWeight="Bold" Foreground="#58A6FF"
                     />
          <TextBlock x:Name="WindowTitleText" Margin="0,2,0,0" FontSize="13" Foreground="#A8B3C7"/>
        </StackPanel>
        <Button x:Name="CloseButton" Grid.Column="2" Width="36" Height="36" Margin="0,0,10,0"
                Background="Transparent" BorderThickness="0" Foreground="#8B98AD"
                FontSize="20" Content="&#x00D7;" Cursor="Hand"/>
      </Grid>

      <Grid Grid.Row="1" Margin="28,18,28,24">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="54"/>
          <ColumnDefinition Width="*"/>
        </Grid.ColumnDefinitions>
        <Border Width="42" Height="42" VerticalAlignment="Top" CornerRadius="12"
                Background="#3A2A12" BorderBrush="#8A5D17" BorderThickness="1">
          <TextBlock Text="!" FontSize="22" FontWeight="Bold" Foreground="#F2CC60"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <StackPanel Grid.Column="1">
          <TextBlock x:Name="HeadingText" FontSize="20" FontWeight="SemiBold"
                     Foreground="#F0F6FC" TextWrapping="Wrap"/>
          <TextBlock Margin="0,8,0,0" Text="&#x8BF7;&#x6838;&#x5BF9;&#x5F71;&#x54CD;&#x8303;&#x56F4;&#xFF0C;&#x786E;&#x8BA4;&#x540E;&#x7CFB;&#x7EDF;&#x624D;&#x4F1A;&#x7EE7;&#x7EED;&#x3002;"
                     FontSize="13" Foreground="#8B98AD"/>
          <Border Margin="0,20,0,0" Padding="16" CornerRadius="10"
                  Background="#111C2E" BorderBrush="#26354D" BorderThickness="1">
            <ScrollViewer MaxHeight="220" VerticalScrollBarVisibility="Auto">
              <TextBlock x:Name="MessageText" FontSize="14" LineHeight="23"
                         Foreground="#C9D1D9" TextWrapping="Wrap"/>
            </ScrollViewer>
          </Border>
          <StackPanel Margin="0,16,0,0" Orientation="Horizontal">
            <Ellipse Width="7" Height="7" Fill="#3FB950" VerticalAlignment="Center"/>
            <TextBlock Margin="8,0,0,0" Text="&#x5B89;&#x5168;&#x786E;&#x8BA4; &#x00B7; &#x4EC5;&#x4F5C;&#x7528;&#x4E8E;&#x5F53;&#x524D;&#x64CD;&#x4F5C;"
                       FontSize="12" Foreground="#7D8CA3"/>
          </StackPanel>
        </StackPanel>
      </Grid>

      <Border Grid.Row="2" Background="#26354D"/>

      <Grid Grid.Row="3" Margin="24,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBlock VerticalAlignment="Center" Text="Esc &#x53D6;&#x6D88; &#x00B7; Tab &#x9009;&#x62E9; &#x00B7; Space &#x786E;&#x8BA4;"
                   FontSize="12" Foreground="#62718A"/>
        <Button x:Name="CancelButton" Grid.Column="1" Style="{StaticResource ActionButton}"
                Content="&#x53D6;&#x6D88;" Background="#172235" BorderBrush="#35445D" Foreground="#D0D7DE"/>
        <Button x:Name="ConfirmButton" Grid.Column="2" Style="{StaticResource ActionButton}"
                Content="&#x786E;&#x8BA4;&#x5E76;&#x7EE7;&#x7EED;" Background="#1F6FEB" BorderBrush="#388BFD" Foreground="White"/>
      </Grid>
    </Grid>
  </Border>
</Window>
"@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$window.Title = $title
$window.FindName("WindowTitleText").Text = $title
$window.FindName("HeadingText").Text = $title -replace '^CodeFlowMu\s*', ''
$window.FindName("MessageText").Text = $message

$confirmButton = $window.FindName("ConfirmButton")
$wordReject = -join ([char[]](0x62D2, 0x7EDD))
$wordApprove = -join ([char[]](0x6279, 0x51C6))
$wordApproval = -join ([char[]](0x5BA1, 0x6279))
$wordVersion = -join ([char[]](0x7248, 0x672C))
$wordDelete = -join ([char[]](0x5220, 0x9664))
$wordClean = -join ([char[]](0x6E05, 0x7406))
$wordInitialize = -join ([char[]](0x521D, 0x59CB, 0x5316))
$labelConfirmReject = -join ([char[]](0x786E, 0x8BA4, 0x62D2, 0x7EDD))
$labelConfirmApprove = -join ([char[]](0x786E, 0x8BA4, 0x6279, 0x51C6))
$labelConfirmChange = -join ([char[]](0x786E, 0x8BA4, 0x4FEE, 0x6539))
$labelConfirmExecute = -join ([char[]](0x786E, 0x8BA4, 0x6267, 0x884C))
if ($title.Contains($wordReject)) {
  $confirmButton.Content = $labelConfirmReject
  $confirmButton.Background = "#DA3633"
  $confirmButton.BorderBrush = "#F85149"
} elseif ($title.Contains($wordApprove) -or $title.Contains($wordApproval)) {
  $confirmButton.Content = $labelConfirmApprove
} elseif ($title.Contains($wordVersion)) {
  $confirmButton.Content = $labelConfirmChange
} elseif ($title.Contains($wordDelete) -or $title.Contains($wordClean) -or $title.Contains($wordInitialize)) {
  $confirmButton.Content = $labelConfirmExecute
}

$script:confirmed = $false
$confirmButton.Add_Click({ $script:confirmed = $true; $window.DialogResult = $true; $window.Close() })
$window.FindName("CancelButton").Add_Click({ $window.DialogResult = $false; $window.Close() })
$window.FindName("CloseButton").Add_Click({ $window.DialogResult = $false; $window.Close() })
$window.FindName("DragArea").Add_MouseLeftButtonDown({ $window.DragMove() })
$window.Add_KeyDown({
  if ($_.Key -eq [System.Windows.Input.Key]::Escape) {
    $window.DialogResult = $false
    $window.Close()
  }
})
$window.Add_Closing({ if (-not $script:confirmed) { $script:confirmed = $false } })

if ($smoke -eq "1") {
  [Console]::Write("__READY__")
  exit 0
}

[void]$window.ShowDialog()
if ($script:confirmed) {
  [Console]::Write("__CONFIRMED__")
} else {
  [Console]::Write("__CANCELLED__")
}
