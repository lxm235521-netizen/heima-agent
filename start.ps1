# 启动 H3 分镜提示词智能体
#
#   .\start.ps1
#
# 从 .env.local 读取监听地址、入站 Key、对外模型名，然后启动服务。
#
# 环境变量用 Node 内置的 --env-file 加载，而不是在 PowerShell 里手写解析：
# 手写解析容易在编码、引号、BOM 上出错，而且失败时是静默的 —— 那会导致
# 「以为开了鉴权，其实是裸奔」。--env-file 由 Node 负责解析，行为确定。

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env.local'
if (-not (Test-Path $envFile)) {
    Write-Host '缺少 .env.local。它保存监听地址与入站 Key，请按 .env.example 创建。' -ForegroundColor Red
    exit 1
}

# 启动前先自检：对外监听却没有入站 Key，等于把上游额度公开。
$check = & node --env-file="$envFile" --input-type=module -e @'
const { loadConfig } = await import("./src/config.js");
const c = loadConfig();
console.log(JSON.stringify({
  host: process.env.HOST || "127.0.0.1",
  port: process.env.PORT || "8787",
  model: c.model || "",
  hasInboundKey: Boolean(c.serverApiKey),
  publicModelId: c.publicModelId,
}));
'@ 2>&1

try {
    $info = $check | ConvertFrom-Json
} catch {
    Write-Host "读取配置失败：$check" -ForegroundColor Red
    exit 1
}

Write-Host "  对外监听:  $($info.host):$($info.port)"
Write-Host "  对外模型:  $($info.publicModelId)"
Write-Host "  生成模型:  $($info.model)"
if ($info.hasInboundKey) {
    Write-Host '  入站鉴权:  已开启' -ForegroundColor Green
} elseif ($info.host -ne '127.0.0.1' -and $info.host -ne 'localhost') {
    Write-Host '  入站鉴权:  未开启，但已对外监听！任何能访问该端口的人都能消耗你的上游额度。' -ForegroundColor Red
    Write-Host '             请在 .env.local 里设置 H3_SERVER_API_KEY。' -ForegroundColor Red
    exit 1
} else {
    Write-Host '  入站鉴权:  未开启（仅本机）' -ForegroundColor Yellow
}
Write-Host ''

node --env-file="$envFile" src/server.mjs
