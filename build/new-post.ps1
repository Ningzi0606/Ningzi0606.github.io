<#
  新建一篇文章的小工具（可选）
  用法：
      powershell -ExecutionPolicy Bypass -File build\new-post.ps1 "文章标题"
      powershell -ExecutionPolicy Bypass -File build\new-post.ps1 "文章标题" my-post-slug
#>

param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Title,
  [Parameter(Position = 1)][string]$Slug
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$postsDir = Join-Path $root 'content\posts'
New-Item -ItemType Directory -Force -Path $postsDir | Out-Null

if (-not $Slug) {
  $Slug = $Title -replace '[^\w\u4e00-\u9fa5-]+', '-'
  $Slug = $Slug.Trim('-')
}
if (-not $Slug) { $Slug = 'untitled' }

$file = Join-Path $postsDir "$Slug.md"
if (Test-Path $file) {
  Write-Host ("File already exists: " + $file) -ForegroundColor Yellow
  exit 1
}

$today = Get-Date -Format 'yyyy-MM-dd'
$template = @"
---
title: $Title
date: $today
tags: []
---

Write here.

"@

# 以 UTF-8（无 BOM）写入正文，避免中文乱码
[System.IO.File]::WriteAllText($file, $template, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("Created: content\posts\" + $Slug + ".md") -ForegroundColor Green
Write-Host 'Next: node build/build.js'
