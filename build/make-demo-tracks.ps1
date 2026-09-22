<#
  生成 3 首免版权的氛围测试曲（带 ID3 标签与封面）
  ==================================================================
  为什么需要它：
      播放器的「单曲循环 / 连续播放 / 随机播放」和播放列表需要多首曲目
      才能看出效果。这些曲子是程序合成的，版权归项目所有者，可随意使用或删除。

  用法：
      powershell -ExecutionPolicy Bypass -File build\make-demo-tracks.ps1

  产出：
      content\music\demo-01-静谧水面.mp3
      content\music\demo-02-夜航.mp3
      content\music\demo-03-远处灯火.mp3
      每首约 38~42 秒，带封面、歌名、歌手、专辑标签。

  换成自己的音乐：
      把 mp3 放进 content\music\ 后，删掉 demo-*.mp3 再跑一次 node build\build.js
#>

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root 'content\music'
$tmp = Join-Path $root '.preview'

# 找 ffmpeg
$ffmpeg = $null
$localFf = Join-Path $root '.tools\ffmpeg\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe'
if (Test-Path $localFf) { $ffmpeg = $localFf }
else {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { $ffmpeg = $cmd.Source }
}
if (-not $ffmpeg) {
  Write-Host '找不到 ffmpeg。先装：winget install Gyan.FFmpeg' -ForegroundColor Red
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '找不到 node.js。' -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "ffmpeg: $ffmpeg" -ForegroundColor DarkGray

# 三首曲子的参数（和弦用频率表示）
$tracks = @(
  @{ file = 'demo-01-静谧水面.mp3'; title = '静谧水面'; seed = 11; seconds = 40
     chords = '110.00,164.81,220.00,261.63;98.00,146.83,196.00,246.94;87.31,130.81,174.61,220.00;110.00,164.81,220.00,329.63' },
  @{ file = 'demo-02-夜航.mp3'; title = '夜航'; seed = 23; seconds = 42
     chords = '82.41,123.47,164.81,207.65;92.50,138.59,185.00,233.08;73.42,110.00,146.83,185.00;65.41,98.00,130.81,196.00' },
  @{ file = 'demo-03-远处灯火.mp3'; title = '远处灯火'; seed = 37; seconds = 38
     chords = '130.81,196.00,261.63,329.63;116.54,174.61,233.08,293.66;103.83,155.56,207.65,311.13;98.00,146.83,196.00,246.94' }
)

$index = 0
foreach ($t in $tracks) {
  $index++
  $wav  = Join-Path $tmp "demo-$index.wav"
  $ppm  = Join-Path $tmp "cover-$index.ppm"
  $jpg  = Join-Path $tmp "cover-$index.jpg"
  $mp3  = Join-Path $tmp "demo-$index.mp3"
  $dest = Join-Path $outDir $t.file

  Write-Host ""
  Write-Host "[$index/$($tracks.Count)] $($t.title)" -ForegroundColor Cyan

  # 1) 合成 WAV（用 node 里的合成代码，这里只传参数）
  & node (Join-Path $root 'build\lib\synth.js') $wav $t.seconds $t.seed $t.chords
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $wav)) {
    Write-Host '  合成失败' -ForegroundColor Red
    continue
  }
  Write-Host ("  WAV  {0:N1} MB" -f ((Get-Item $wav).Length / 1MB)) -ForegroundColor DarkGray

  # 2) 封面：PPM -> JPEG
  & node (Join-Path $root 'build\lib\synth.js') --cover $ppm $index
  & $ffmpeg -y -hide_banner -loglevel error -i $ppm -q:v 3 $jpg

  # 3) WAV -> MP3
  & $ffmpeg -y -hide_banner -loglevel error -i $wav -c:a libmp3lame -b:a 160k -ar 44100 -ac 2 $mp3
  if (-not (Test-Path $mp3)) { Write-Host '  转码失败' -ForegroundColor Red; continue }
  Write-Host ("  MP3  {0:N0} KB" -f ((Get-Item $mp3).Length / 1KB)) -ForegroundColor DarkGray

  # 4) 写入 ID3 标签（含封面）—— 用 node 复用 build/lib/id3.js
  & node (Join-Path $root 'build\lib\tag.js') $mp3 $dest $t.title $jpg '霞光凝暮山紫' '网站测试曲'
  if (Test-Path $dest) {
    Write-Host ("  完成 {0}  {1:N0} KB" -f $t.file, ((Get-Item $dest).Length / 1KB)) -ForegroundColor Green
  } else {
    Write-Host '  写标签失败' -ForegroundColor Red
  }

  Remove-Item $wav, $ppm, $jpg, $mp3 -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host '完成。接下来：node build\build.js' -ForegroundColor Cyan
Write-Host '换成自己的音乐：把 mp3 放进 content\music\，删掉 demo-*.mp3' -ForegroundColor DarkGray
