# 托盘图标客观验证：用 UI Automation 枚举通知区域按钮
# 兼容 Windows PowerShell 5.1（不使用多行构造函数）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$found = $false
$candidates = @()
$err = $null

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty), 'Shell_TrayWnd'
    $tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

    if ($null -eq $tray) {
        $err = 'FindFirst(Shell_TrayWnd) returned null'
    }
    else {
        $btnCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
        $buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
        foreach ($b in $buttons) {
            $n = $b.Current.Name
            if ($n) { $candidates += $n }
        }
        $hit = $candidates | Where-Object { $_ -like '*莞工*' -or $_ -like '*Deadline*' }
        if ($hit) { $found = $true }
    }
}
catch {
    $err = $_.Exception.Message
}

$out = [ordered]@{
    found      = $found
    count      = $candidates.Count
    matches    = @($candidates | Where-Object { $_ -like '*莞工*' -or $_ -like '*Deadline*' })
    candidates = $candidates
    error      = $err
}
$out | ConvertTo-Json -Depth 4
