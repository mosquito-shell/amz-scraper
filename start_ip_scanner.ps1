# IP 池 7×24 持续扫描 — 每小时运行一次，累加不覆盖
# 用法: powershell -ExecutionPolicy Bypass -File start_ip_scanner.ps1
# 或注册为 Windows 计划任务(推荐):
#   打开"任务计划程序" → 创建任务 → 触发器: 每1小时重复 → 操作: 启动程序 powershell.exe
#   参数: -ExecutionPolicy Bypass -File "D:\田晟司\amz-scraper\start_ip_scanner.ps1"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  IP 池 7×24 持续扫描" -ForegroundColor Cyan
Write-Host "  时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

python ip_scanner.py --full --max 80

Write-Host ""
Write-Host "扫描完成. 当前 IP 池:" -ForegroundColor Green
python ip_scanner.py --show

Write-Host ""
Write-Host "下次扫描: 60 分钟后" -ForegroundColor Yellow
