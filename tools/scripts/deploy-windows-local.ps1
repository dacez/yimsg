# 更新 Windows 本机部署（研发/演示用，见 docs/deployment/部署方案.md 第 11 节）：
# 编译最新的服务端 / seed-demo 二进制与前端产物，停止 YimsgServer 计划任务，
# 替换 C:\yimsg 下的二进制与静态资源，用新构建的 seed-demo 清空重建演示数据，
# 最后重新启动计划任务并做一次健康检查。
#
# 前提：已通过 install-windows-autostart.ps1 完成首次部署（C:\yimsg\config.toml
# 已存在）；本脚本只负责"更新"，不负责首次注册计划任务。
#
# 必须在管理员（提权）PowerShell 中运行，否则无权停止/启动 SYSTEM 身份的计划任务：
#   powershell -ExecutionPolicy Bypass -File tools\scripts\deploy-windows-local.ps1

param(
    [string]$DeployRoot = "C:\yimsg"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# Windows PowerShell 5.1 下，$ErrorActionPreference = "Stop" 会把外部命令写到 stderr 的
# 每一行都当成终止性错误处理——即便该命令最终以退出码 0 成功（例如 vite 打印的
# "Module externalized for browser compatibility" 之类的正常告警）。外部命令一律走
# Invoke-Native，只认退出码，不被 stderr 输出误伤。
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$ExeArgs = @()
    )
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Exe @ExeArgs
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($LASTEXITCODE -ne 0) {
        throw "命令失败（退出码 $LASTEXITCODE）：$Exe $($ExeArgs -join ' ')"
    }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "请在管理员（提权）PowerShell 中运行本脚本"
}

$configFile = Join-Path $DeployRoot "config.toml"
if (-not (Test-Path $configFile)) {
    Write-Error "$configFile 不存在，请先按 docs/deployment/部署方案.md 第 11.1 节完成首次部署"
}

Set-Location $repoRoot

Write-Host "Step 1: 编译服务端与 seed-demo 二进制"
Invoke-Native "go" @("build", "-o", "server.exe", ".\server\cmd\yimsg-server")
Invoke-Native "go" @("build", "-o", "seed-demo.exe", ".\server\tools\cmd\seed-demo")

Write-Host "Step 2: 刷新协议生成物"
Invoke-Native "go" @("run", ".\tools\cmd\protocolgen")

Write-Host "Step 3: 构建前端产物"
Invoke-Native "npm" @("run", "build")

Write-Host "Step 4: 停止 YimsgServer 计划任务"
Stop-ScheduledTask -TaskName "YimsgServer" -ErrorAction SilentlyContinue
Get-Process -Name server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

Write-Host "Step 5: 替换二进制与静态产物"
Copy-Item "$repoRoot\server.exe" "$DeployRoot\server.exe" -Force
Copy-Item "$repoRoot\seed-demo.exe" "$DeployRoot\seed-demo.exe" -Force
if (Test-Path "$DeployRoot\web") { Remove-Item "$DeployRoot\web" -Recurse -Force }
Copy-Item "$repoRoot\web" "$DeployRoot\web" -Recurse -Force
if (Test-Path "$DeployRoot\website") { Remove-Item "$DeployRoot\website" -Recurse -Force }
Copy-Item "$repoRoot\website" "$DeployRoot\website" -Recurse -Force

Write-Host "Step 6: 用新构建的 seed-demo 清空并重建 data/（含官网演示账号）"
Invoke-Native "$DeployRoot\seed-demo.exe" @("-config", $configFile)

Write-Host "Step 7: 启动 YimsgServer 计划任务"
Start-ScheduledTask -TaskName "YimsgServer"
Start-Sleep -Seconds 2

Write-Host "Step 8: 校验"
Get-ScheduledTask -TaskName "YimsgServer" | Select-Object TaskName, State
Get-Process -Name server -ErrorAction SilentlyContinue | Select-Object Id, StartTime
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1/" -UseBasicParsing -TimeoutSec 5
    Write-Host "http://127.0.0.1/ -> $($r.StatusCode)"
} catch {
    Write-Host "http://127.0.0.1/ FAILED: $($_.Exception.Message)"
}

Write-Host "部署完成"
