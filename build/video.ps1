<#
  视频转码脚本：把下载好的原片转成网页友好的 H.264 MP4
  ------------------------------------------------------------------
  用法（在项目根目录执行）：
      powershell -ExecutionPolicy Bypass -File build\video.ps1
      powershell -ExecutionPolicy Bypass -File build\video.ps1 -Source "C:\某个路径\luna.mp4"
      powershell -ExecutionPolicy Bypass -File build\video.ps1 -Crf 23

  默认行为：
    - 自动找 content\media\ 里的 mp4 / mkv / webm / flv / mov（取最大的那个）
    - 转成 H.264 + AAC、保持原帧率、原分辨率（宽度超过 1920 时缩到 1920）
    - 加 faststart，浏览器可以边下边播
    - 输出到 assets\video\<名字>.mp4

  Crf 是画质档位：18 更好更占空间，20 推荐，23 体积更小。
#>

param(
  [string]$Source,
  [string]$Name = 'luna',
  [int]$Crf = 20
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$mediaDir = Join-Path $root 'content\media'
$outDir = Join-Path $root 'assets\video'

# 1. 检查 ffmpeg
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
  Write-Host '没有找到 ffmpeg。用下面任意一条命令安装后重开终端：' -ForegroundColor Yellow
  Write-Host '    winget install Gyan.FFmpeg' -ForegroundColor Cyan
  Write-Host '    winget install ffmpeg' -ForegroundColor Cyan
  exit 1
}

# 2. 找输入文件
if (-not $Source) {
  $cand = Get-ChildItem $mediaDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.(mp4|mkv|webm|flv|mov|ts|m4v)$' } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if (-not $cand) {
    Write-Host '没找到视频。请把下载好的文件放进：' -ForegroundColor Yellow
    Write-Host "    $mediaDir" -ForegroundColor Cyan
    exit 1
  }
  $Source = $cand.FullName
}

if (-not (Test-Path $Source)) {
  Write-Host "文件不存在：$Source" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir "$Name.mp4"

$inSize = [Math]::Round((Get-Item $Source).Length / 1MB, 1)
Write-Host "输入：$Source（$inSize MB）" -ForegroundColor Cyan
Write-Host '探测原片信息…' -ForegroundColor DarkGray

& $ffmpeg -hide_banner -i $Source 2>&1 |
  Select-String -Pattern 'Stream #|Duration' |
  ForEach-Object { Write-Host ('  ' + $_.Line.Trim()) -ForegroundColor DarkGray }

Write-Host ''
Write-Host "开始转码（H.264 + AAC，CRF $Crf，保留原帧率）…" -ForegroundColor Cyan

& $ffmpeg -y -hide_banner -loglevel warning -stats -i $Source -c:v libx264 -preset medium -crf $Crf -pix_fmt yuv420p -vf "scale='min(1920,iw)':-2" -c:a aac -b:a 192k -ac 2 -movflags +faststart $out

if ($LASTEXITCODE -ne 0) {
  Write-Host '转码失败。' -ForegroundColor Red
  exit $LASTEXITCODE
}

$outSize = [Math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ''
Write-Host "完成：$out（$outSize MB）" -ForegroundColor Green
Write-Host '接下来在 content\videos.md 里把视频地址指向它，例如：' -ForegroundColor DarkGray
Write-Host ('    ::video[assets/video/' + $Name + '.mp4]{title="视频标题"}') -ForegroundColor DarkGray
Write-Host '然后运行 node build\build.js' -ForegroundColor DarkGray

# GitHub 单文件 100MB 上限提醒
if ($outSize -gt 95) {
  Write-Host ''
  Write-Host '注意：文件超过 95 MB，GitHub 单文件硬上限是 100 MB。' -ForegroundColor Yellow
  Write-Host '可以改用 -Crf 23 压得更小，或者让我改成 HLS 分片方案。' -ForegroundColor Yellow
}
