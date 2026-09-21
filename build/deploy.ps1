<#
  一键发布到 GitHub Pages
  ------------------------------------------------------------------
  首次使用（会引导你登录 GitHub）：
      powershell -ExecutionPolicy Bypass -File build\deploy.ps1 -User 你的用户名

  之后每次更新内容，只要：
      powershell -ExecutionPolicy Bypass -File build\deploy.ps1

  脚本做的事情：
    1. 重新生成网站（node build/build.js）
    2. 如果是第一次：git init、关联远程仓库
    3. git add / commit / push
    4. 推上去后 GitHub Actions 会自动部署到 Pages
#>

param(
  [string]$User,                                  # GitHub 用户名
  [string]$Repo = '',                             # 仓库名，默认用「用户名.github.io」
  [string]$Message = '',                          # 提交信息，默认带时间
  [string]$Name = '',                             # git 提交者名字（仅首次需要）
  [string]$Email = ''                             # git 提交者邮箱（仅首次需要）
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# ---------- 1. 检查 git ----------
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) {
  Say '没有找到 git。先安装（装完重开终端）：' 'Yellow'
  Say '    winget install Git.Git' 'Cyan'
  exit 1
}

# ---------- 2. 检查 node ----------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say '没有找到 node.js，无法生成网站。' 'Red'
  exit 1
}

# ---------- 3. 检查提交者身份（git 提交必须知道作者是谁）----------
$cfgName = (& git config --global user.name) 2>$null
$cfgEmail = (& git config --global user.email) 2>$null

if ($Name -and $Email) {
  Say "设置 git 提交者身份：$Name <$Email>" 'Cyan'
  & git config --global user.name $Name
  & git config --global user.email $Email
  $cfgName = $Name; $cfgEmail = $Email
}

if (-not $cfgName -or -not $cfgEmail) {
  Say 'git 还不知道你是谁，提交会失败（报错：Author identity unknown）。' 'Yellow'
  Say '有两种办法：' 'Yellow'
  Say ''
  Say '  ① 让脚本设置（把下面的名字和邮箱换成你自己的）：' 'Cyan'
  Say '     powershell -ExecutionPolicy Bypass -File build\deploy.ps1 -User Ningzi0606 `' 'Cyan'
  Say '       -Name "凝紫" -Email "你的邮箱@example.com"' 'Cyan'
  Say ''
  Say '  ② 自己在终端里设置一次（以后就不用再设）：' 'Cyan'
  Say '     git config --global user.name "凝紫"' 'Cyan'
  Say '     git config --global user.email "你的邮箱@example.com"' 'Cyan'
  Say ''
  Say '提示：邮箱会出现在公开仓库的提交记录里。不想暴露真实邮箱，可以用 GitHub 提供的' 'DarkGray'
  Say '      隐私邮箱，格式是 数字+用户名@users.noreply.github.com' 'DarkGray'
  exit 1
}

Say "提交者身份：$cfgName <$cfgEmail>" 'DarkGray'

# ---------- 4. 生成网站 ----------
Say '正在生成网站…' 'Cyan'
& node build\build.js
if ($LASTEXITCODE -ne 0) { Say '生成失败。' 'Red'; exit 1 }

# ---------- 5. 是否已是 git 仓库 ----------
$isRepo = Test-Path (Join-Path $root '.git')

if (-not $isRepo) {
  if (-not $User) {
    Say '第一次发布需要告诉脚本你的 GitHub 用户名，例如：' 'Yellow'
    Say '    powershell -ExecutionPolicy Bypass -File build\deploy.ps1 -User Ningzi0606' 'Cyan'
    exit 1
  }
  if (-not $Repo) { $Repo = "$User.github.io" }

  Say "初始化仓库（远程地址 https://github.com/$User/$Repo.git）…" 'Cyan'
  & git init | Out-Null
  & git branch -M main
  & git remote add origin "https://github.com/$User/$Repo.git"
} else {
  Say '已检测到 git 仓库，继续提交本次改动。' 'DarkGray'
  $remote = (& git remote get-url origin 2>$null)
  if ($remote) { Say "远程仓库：$remote" 'DarkGray' }
}

# ---------- 6. 提交 ----------
if (-not $Message) {
  $Message = '更新站点 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
}

Say '暂存改动…' 'Cyan'
& git add -A

$committed = $false
$staged = (& git diff --cached --name-only | Measure-Object -Line).Lines
if ($staged -eq 0) {
  Say '没有新的改动需要提交。' 'Yellow'
  # 没有新改动，但可能之前从没提交过（分支还不存在）
  $hasCommit = (& git rev-parse --verify HEAD 2>$null)
  if (-not $hasCommit) {
    Say '仓库里还没有任何提交，创建一个初始提交…' 'Cyan'
    & git commit --allow-empty -m $Message | Out-Null
    $committed = $true
  }
} else {
  Say "本次改动 $staged 个文件：" 'DarkGray'
  & git diff --cached --name-status | Select-Object -First 20 | ForEach-Object { Say "    $_" 'DarkGray' }
  & git commit -m $Message | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Say '提交失败。如果提示 Author identity unknown，说明提交者身份没设好，重跑本脚本即可。' 'Red'
    exit 1
  }
  $committed = $true
  Say '已提交。' 'Green'
}

# 提交前必须确认分支真的存在，否则 push 会报 src refspec does not match any
$branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
if (-not $branch) { $branch = 'main' }
$hasBranch = (& git rev-parse --verify HEAD 2>$null)
if (-not $hasBranch) {
  Say '提交没有成功，无法推送。请把上面的报错发给我。' 'Red'
  exit 1
}
Say "当前分支：$branch" 'DarkGray'

# ---------- 7. 推送 ----------
Say '推送到 GitHub…（首次会弹出登录窗口）' 'Cyan'
& git push -u origin $branch
if ($LASTEXITCODE -ne 0) {
  Say ''
  Say '推送失败。对照下面的现象排查：' 'Yellow'
  Say '  · Author identity unknown —— 提交者身份没设置（本脚本现在会提前拦住）' 'Yellow'
  Say '  · src refspec ... does not match any —— 没有成功提交，分支不存在' 'Yellow'
  Say '  · Authentication failed —— 没登录 GitHub，重跑一次并在弹窗里授权' 'Yellow'
  Say '  · Repository not found —— 仓库名写错，或仓库还没建' 'Yellow'
  Say '  · 卡在某个百分比不动 —— 正在上传大文件（视频 61MB），耐心等' 'Yellow'
  exit 1
}

Say ''
Say '推送成功！' 'Green'
if ($User) {
  Say "网站地址（首次需等 1~2 分钟部署）：https://$User.github.io/" 'Cyan'
  if ($Repo -and $Repo -ne "$User.github.io") {
    Say "仓库名不是「$User.github.io」，所以实际地址是：https://$User.github.io/$Repo/" 'DarkGray'
  }
  Say ''
  Say '别忘了最后一步：仓库 Settings → Pages → Source 选 GitHub Actions' 'Cyan'
}
Say '在仓库的 Actions 标签可以看部署进度。' 'DarkGray'
