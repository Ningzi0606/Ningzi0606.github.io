<#
  一次性优化：让 Git 不再跟踪「自动生成的网页」
  ------------------------------------------------------------------
  做两件事：
    1. 把已提交的生成文件（index.html、posts/ 等）从 Git 索引里移除
       —— 文件仍留在本地，网站不受影响
    2. 提交并推送

  为什么要做：
    生成的文件每次都会变，Git 会永久保留每一版，仓库会随时间膨胀
    （改一个字 = 一整套新 HTML）。移除后只跟踪源文件（content/ 里的
    Markdown、图片、音乐，以及 assets/、build/）。
    GitHub Actions 部署时会自动重新生成，所以线上完全不受影响。

  用法：
      powershell -ExecutionPolicy Bypass -File build\slim-repo.ps1
      powershell -ExecutionPolicy Bypass -File build\slim-repo.ps1 -DryRun   # 只预览不执行
#>

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { Say '没找到 git，先装：winget install Git.Git' 'Red'; exit 1 }

if (-not (Test-Path (Join-Path $root '.git'))) {
  Say '这不是一个 git 仓库（没有 .git 目录）。' 'Red'
  exit 1
}

# 需要从跟踪中移除的路径（必须与 .gitignore 里的规则一致）
$paths = @('index.html', '404.html', 'posts', 'photos', 'videos', 'about', 'music')

Say '检查当前被跟踪的生成文件…' 'Cyan'
$tracked = @()
foreach ($p in $paths) {
  $found = & git ls-files -- $p
  if ($found) { $tracked += $found }
}

if ($tracked.Count -eq 0) {
  Say '这些生成文件已经没有在被跟踪了，无需操作。' 'Yellow'
  exit 0
}

Say "将被移出版本库的 $($tracked.Count) 个文件：" 'DarkGray'
$tracked | Select-Object -First 15 | ForEach-Object { Say "    $_" 'DarkGray' }
if ($tracked.Count -gt 15) { Say "    …（共 $($tracked.Count) 个）" 'DarkGray' }

if ($DryRun) {
  Say ''
  Say '这只是预览。去掉 -DryRun 参数即可真正执行。' 'Yellow'
  exit 0
}

Say ''
Say '从 Git 索引中移除（本地文件保留）…' 'Cyan'
foreach ($p in $paths) {
  & git rm -r --cached --quiet --ignore-unmatch -- $p
}

Say '确认 .gitignore 生效…' 'Cyan'
& git add -A
& git status --short | Select-Object -First 20 | ForEach-Object { Say "    $_" 'DarkGray' }

Say ''
Say '提交…' 'Cyan'
$msg = '优化仓库：生成文件不再纳入版本控制（由 Actions 部署时生成）'
& git commit -m $msg
if ($LASTEXITCODE -ne 0) {
  Say '提交失败（可能没有变化）。' 'Yellow'
  exit 1
}

Say '推送…' 'Cyan'
$branch = (& git rev-parse --abbrev-ref HEAD)
& git push origin $branch
if ($LASTEXITCODE -ne 0) { Say '推送失败，把上面的报错发我。' 'Red'; exit 1 }

Say ''
Say '完成！' 'Green'
Say '现在仓库里只有源文件；网页由 GitHub Actions 在部署时生成。' 'DarkGray'
Say '访问 https://ningzi0606.github.io 验证（等 1~2 分钟部署完成）。' 'Cyan'
Say ''
Say '注意：以后本地改完内容，仍然要跑 build\deploy.ps1 来推送。' 'DarkGray'
Say '生成的 HTML 不会被提交，但 Actions 会自动重建，所以线上是新的。' 'DarkGray'
