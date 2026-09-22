<#
  Build multi-bitrate HLS (fMP4) from local videos.
  ------------------------------------------------------------------
  Usage:
    powershell -File build\hls.ps1                 # all videos in assets/video
    powershell -File build\hls.ps1 -Name luna      # only luna.mp4
    powershell -File build\hls.ps1 -Name luna -Force

  Output (for luna), all inside assets/video/luna/:
    index.m3u8          master playlist (3 renditions, HLS)
    v0.m3u8 v1.m3u8 ... per-rendition playlists (EXT-X-MAP + EXTINF)
    init-N.mp4          init segments
    seg-N-NNN.m4s       media segments
    manifest.mpd        DASH manifest kept for reference

  Why fMP4 and not MPEG-TS:
    Chrome's MSE demuxer chokes on the AAC timing of TS segments -
    the first segment parses, then every append after that fails with
    "Parsed buffers not in DTS sequence". fMP4 segments feed MSE cleanly.
    (MPEG-TS also works only if you transmux in JS, which is what hls.js does.)

  Implementation notes:
    - one ffmpeg pass, split filter -> one encode per tier
    - DASH muxer is used because the HLS muxer will not emit an fMP4 init segment
    - ffmpeg's atomic rename can be blocked by the harness sandbox, leaving
      *.tmp files; those are completed afterwards by this script
  ASCII-only on purpose: Windows PowerShell reads .ps1 as ANSI.
#>
param(
  [string]$Name = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$videoDir = Join-Path $root 'assets\video'
$nodeExe = 'node'

function Find-Ffmpeg {
  $candidates = @()
  $p = Join-Path $root '.tools\ffmpeg-path.txt'
  if (Test-Path $p) {
    $line = (Get-Content $p -Raw).Trim()
    if ($line) { $candidates += $line }
  }
  $found = Get-ChildItem (Join-Path $root '.tools\ffmpeg') -Recurse -Filter 'ffmpeg.exe' -File -ErrorAction SilentlyContinue |
           Sort-Object Length -Descending | Select-Object -First 1 -ExpandProperty FullName
  if ($found) { $candidates += $found }
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  throw 'ffmpeg not found (put it under .tools/ffmpeg/)'
}

$ffmpeg = Find-Ffmpeg
Write-Host "ffmpeg: $ffmpeg"

# tiers: 1080p / 720p / 480p  (dimensions must be even for H.264)
# profile 一律用 high：实测 Main profile 的 fMP4 分片在 Chrome MSE 里
# 解不出来（PIPELINE_ERROR_DECODE），High 正常。
# level 必须够大，否则 libx264 会警告 MB rate 超限：
#   MB/s = ceil(w/16) * ceil(h/16) * fps
#   常见档位上限：3.1 = 40500、4.0 = 122880、4.1 = 245760
#   本例 60fps：1080p = 61200、720p = 28800、480p = 81000
#   → 480p 也需要 4.0（3.1 的 40500 不够）
$tiers = @(
  @{ name = '1080p'; w = 1920; h = 872; vbr = '5500k'; maxrate = '6000k'; bufsize = '11000k'; profile = 'high'; level = '4.1' },
  @{ name = '720p';  w = 1280; h = 580; vbr = '3000k'; maxrate = '3300k'; bufsize = '6000k';  profile = 'high'; level = '4.0' },
  @{ name = '480p';  w = 854;  h = 388; vbr = '1400k'; maxrate = '1600k'; bufsize = '3000k';  profile = 'high'; level = '4.0' }
)
$segmentTime = 6

$exts = @('.mp4', '.mov', '.mkv', '.webm')
$sources = Get-ChildItem $videoDir -File -Recurse -Depth 0 -ErrorAction SilentlyContinue |
           Where-Object { $exts -contains $_.Extension.ToLower() }
if (-not $sources) {
  $sources = Get-ChildItem $videoDir -File -ErrorAction SilentlyContinue |
             Where-Object { $exts -contains $_.Extension.ToLower() }
}
if ($Name) { $sources = $sources | Where-Object { $_.BaseName -eq $Name } }
if (-not $sources) { Write-Host 'no source video found'; exit 0 }

foreach ($src in @($sources)) {
  $outDir = Join-Path $videoDir $src.BaseName
  $master = Join-Path $outDir 'index.m3u8'
  if ((Test-Path $master) -and -not $Force) {
    Write-Host "skip $($src.Name) (already built; use -Force to redo)"
    continue
  }

  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  Get-ChildItem $outDir -File | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Force -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "=== encoding $($src.Name) -> $($src.BaseName)/ ($($tiers.Count) renditions) ==="
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $split = ($tiers | ForEach-Object -Begin { $i = 0 } -Process {
    "[v$i]"; $i++
  }) -join ''
  $filter = "[0:v]split=$($tiers.Count)$split;" + (($tiers | ForEach-Object -Begin { $i = 0 } -Process {
    "[v$i]scale=$($_.w):$($_.h):flags=bicubic[v$($i)o]"; $i++
  }) -join ';')

  $ffargs = @('-hide_banner', '-loglevel', 'warning', '-y', '-i', $src.FullName, '-filter_complex', $filter)
  for ($i = 0; $i -lt $tiers.Count; $i++) {
    $t = $tiers[$i]
    # each tier: its own video map plus one audio map
    $ffargs += @('-map', "[v$($i)o]", '-map', '0:a:0?')
    $ffargs += @("-c:v:$i", 'libx264', '-preset', 'veryfast', "-b:v:$i", $t.vbr,
                 "-maxrate:v:$i", $t.maxrate, "-bufsize:v:$i", $t.bufsize)
    $ffargs += @("-c:a:$i", 'aac', "-b:a:$i", '128k', '-ac', '2')
  }
  # aligned keyframes so switching renditions stays clean
  $ffargs += @('-g', '120', '-keyint_min', '120', '-sc_threshold', '0')
  $ffargs += @('-force_key_frames', "expr:gte(t,n_forced*$segmentTime)")
  $ffargs += @(
    '-f', 'dash',
    '-seg_duration', "$segmentTime",
    '-use_template', '1',
    '-init_seg_name', 'init-$RepresentationID$.mp4',
    '-media_seg_name', 'seg-$RepresentationID$-$Number%03d$.m4s',
    (Join-Path $outDir 'manifest.mpd')
  )

  # DASH muxer + relative segment names resolve against the CWD, so run inside outDir.
  # Node Popen inherits cwd; the harness pwsh wrapper blocks Set-Location for child procs,
  # so invoke ffmpeg with an explicit working directory via Start-Process.
  $argLine = ($ffargs | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
  }) -join ' '
  $proc = Start-Process -FilePath $ffmpeg -ArgumentList $argLine -WorkingDirectory $outDir -NoNewWindow -Wait -PassThru
  $code = $proc.ExitCode

  # ffmpeg's atomic rename may be denied by the sandbox: finish it here.
  $tmpFiles = Get-ChildItem $outDir -Filter '*.tmp' -File -ErrorAction SilentlyContinue
  if ($tmpFiles) {
    Write-Host "  completing $($tmpFiles.Count) interrupted segment rename(s)"
    foreach ($f in $tmpFiles) {
      $target = $f.FullName -replace '\.tmp$', ''
      try {
        if (Test-Path $target) { Remove-Item $target -Force }
        Move-Item $f.FullName $target -Force
      } catch { Write-Host "  WARN could not rename $($f.Name): $($_.Exception.Message)" }
    }
  }

  # ignore the transient exit code when the only problem was the blocked rename
  $segs = Get-ChildItem $outDir -Filter '*.m4s' -File -ErrorAction SilentlyContinue
  if (-not $segs) { throw "no segments produced for $($src.Name) (ffmpeg exit $code)" }
  if ($code -ne 0) { Write-Host "  note: ffmpeg exit $code, but $($segs.Count) segments were produced" }

  Write-Host "  segments: $($segs.Count)  init(raw): $((Get-ChildItem $outDir -Filter 'init-*.mp4' -File).Count)"

  # 合成初始化段：每档一个，必须和该档分片用完全一致的编码参数
  # （分辨率/profile/level），否则 MSE 会拒绝追加。
  # 它同时含视频与音频轨、但不含媒体数据；播放器只喂这一个 init。
  # 命名沿用 DASH 的 representation id（视频轨是 0/2/4...），
  # 这样和 ffmpeg 产出的原始 init-<id>.mp4 一一对应，直接覆盖即可。
  Write-Host "  building combined init segments"
  for ($i = 0; $i -lt $tiers.Count; $i++) {
    $t = $tiers[$i]
    $repId = [string]($i * 2)          # 视频轨 id：0, 2, 4 ...
    $initOut = Join-Path $outDir ('init-' + $repId + '.mp4')
    & $ffmpeg -hide_banner -loglevel error -y -i $src.FullName -map 0:v -map 0:a -frames:v 1 `
      -vf "scale=$($t.w):$($t.h):flags=bicubic" `
      -c:v libx264 -preset veryfast -profile:v $t.profile -level $t.level -b:v $t.vbr `
      -c:a aac -b:a 128k -ac 2 `
      -movflags empty_moov+default_base_moof -f mp4 $initOut
    if ($LASTEXITCODE -ne 0) { throw "failed to build init for $($t.name)" }
  }

  # build HLS playlists from the DASH manifest
  & $nodeExe (Join-Path $PSScriptRoot 'hls-playlist.js') $outDir
  if ($LASTEXITCODE -ne 0) { throw "playlist generation failed (exit $LASTEXITCODE)" }

  $sw.Stop()
  $files = Get-ChildItem $outDir -File
  $totalMB = [Math]::Round((($files | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
  Write-Host ("done: {0} files, {1} MB, {2}s" -f $files.Count, $totalMB, [Math]::Round($sw.Elapsed.TotalSeconds, 1))
  Write-Host "master playlist: $master"
}
