# 我的个人网站

一个极简的个人网站：文字、照片、视频。
内容全部存在本地的 Markdown 文件和文件夹里，用一段零依赖的 Node 脚本生成静态网页 —— 打开快、无广告、可直接托管到 GitHub Pages。

```
内容（你写的）                      生成（自动产出的网页）
content/index.md      ─┐
content/about.md       │
content/photos.md      ├─→  node build/build.js  ─→  index.html
content/videos.md      │                              posts/**/index.html
content/posts/*.md     │                              photos/index.html
content/photos/*.jpg  ─┘                              videos/index.html
                                                      about/index.html
```

---

## 一、本地预览

需要先装 [Node.js](https://nodejs.org)（18 以上版本即可）。

在项目文件夹里打开终端（PowerShell），运行：

```powershell
node build/serve.js
```

然后浏览器打开 **http://localhost:5173/** 就能看到网站。

想边改边看（改动 `content/` 后自动重新生成）：

```powershell
node build/serve.js --watch
```

> 也可以直接双击 `index.html` 打开。页面里用的是相对路径，所以离线打开同样能正常跳转。

---

## 二、日常更新内容

每次改完内容，运行一次生成命令即可：

```powershell
node build/build.js
```

### 1. 写一篇文章

在 `content/posts/` 里新建一个 `.md` 文件，例如 `content/posts/我的第一篇随笔.md`：

```markdown
---
title: 我的第一篇随笔
date: 2025-02-14
tags: [生活, 随笔]
excerpt: 一句话摘要，会显示在列表页（可以不写，会自动截取）
---

正文从这里开始。
```

文件名会变成网址，例如这篇文章的地址是 `/posts/我的第一篇随笔/`。
想固定网址，可以在开头加一行 `slug: my-first-post`。
加 `draft: true` 则这篇文章不会出现在网站上。

### 2. 添加照片

把图片（`.jpg` / `.png` / `.webp` / `.gif` / `.svg`）直接放进 `content/photos/` 文件夹，然后运行生成命令。
相册页会自动按文件名顺序展示，点开可以放大、方向键翻页。

想让某张照片出现在**文章正文**里，就在 Markdown 里写：

```markdown
![照片说明](content/photos/我的照片.jpg)
```

### 3. 添加视频

编辑 `content/videos.md`，用 `::video[地址]` 添加，一行一个：

```markdown
::video[content/media/我的视频.mp4]{poster="content/photos/封面图.jpg" title="视频标题"}

::video[https://www.bilibili.com/video/BV1xx411c7mD]{title="B 站视频"}

::video[https://www.youtube.com/watch?v=xxxxxxxxxxx]{title="YouTube 视频"}
```

- 本地视频文件放进 `content/media/` 文件夹（`.mp4` / `.webm` / `.mov` 都行）
- B 站、YouTube 链接会自动识别成播放器
- `poster` 是封面图，`title` 是显示在下面的说明，都可以省略

> 建议单个视频文件不要超过 50 MB。太大的话上传慢，也可以先传到 B 站或 YouTube 再嵌链接。

### 4. 改名字、简介、联系方式

打开 **`site.config.json`**：

```json
{
  "title": "我的个人网站",
  "name": "你的名字",
  "tagline": "写一点文字，存一些照片，留几段视频。",
  "links": [
    { "label": "邮箱", "url": "mailto:you@example.com" },
    { "label": "微信", "url": "your-wechat-id", "type": "text" }
  ]
}
```

- `name` 显示在网站左上角
- `links` 是「联系我」的按钮；加 `"type": "text"` 的条目只显示文字，不会变成链接
- 首页的自我介绍写在 `content/index.md`，「关于我」页写在 `content/about.md`

### 5. 换头像和配色

- 头像：替换 `assets/avatar.svg`，或在 `site.config.json` 里把 `avatar` 指向别的图片
- 配色和字号：改 `assets/style.css` 最上面那段 `:root` 变量（`--accent` 是强调色）
- 浏览器标签页图标：替换 `assets/favicon.svg`

---

## 三、发布到 GitHub Pages（免费托管）

> **注意**：GitHub 用户名只能是**英文字母、数字、连字符**，不支持中文。
> 中文昵称可以填在个人资料的 Name 字段里显示，但登录名和网址必须是 ASCII。
> 本项目的用户名是 **`Ningzi0606`**，仓库名用 **`Ningzi0606.github.io`**，
> 上线后网址就是 **https://ningzi0606.github.io**

### 方式一：一条命令发布（推荐，需要装 Git）

1. 装 Git（只需一次）：

   ```powershell
   winget install Git.Git
   ```

   装完**关掉终端重新打开**（让 PATH 生效）。

2. 先去 GitHub 新建一个**空仓库**：右上角 `+` → `New repository`
   - 仓库名填 **`Ningzi0606.github.io`** → 网址就是 `https://ningzi0606.github.io`
   - 填别的名字也行 → 网址变成 `https://ningzi0606.github.io/仓库名/`
   - 选 `Public`，**不要**勾 "Add a README file"

3. 回到项目目录，跑一次发布脚本（会自动生成网站 + 提交 + 推送）：

   ```powershell
   cd C:\deepseek
   powershell -ExecutionPolicy Bypass -File build\deploy.ps1 -User Ningzi0606
   ```

   首次会弹出 GitHub 登录窗口，登录一次以后就不用再登。

4. **开启 Pages**：仓库 → `Settings` → 左侧 `Pages` → `Build and deployment`
   → `Source` 选 **GitHub Actions**。

5. 等 1~2 分钟，仓库的 `Actions` 标签变绿后访问你的网址即可。

**以后每次更新内容，只要一条命令：**

```powershell
powershell -ExecutionPolicy Bypass -File build\deploy.ps1
```

它会自动重新生成网站、提交改动、推送。推上去后 GitHub Actions 会自动重新部署。

### 方式二：网页拖拽上传（不想装 Git 时用）

1. 在 GitHub 新建空仓库（同上）
2. 仓库页面点 `Add file` → `Upload files`，把 `C:\deepseek` 里**所有文件和文件夹**拖进去
   - ⚠️ `.github`、`.gitignore`、`.nojekyll` 是隐藏项，需要在资源管理器里
     **查看 → 勾选「隐藏的项目」** 才看得到。**`.github` 必须上传**，它是自动部署脚本
3. `Settings` → `Pages` → `Source` 选 **GitHub Actions**
4. 等 Actions 变绿后访问

> 缺点：网页上传不支持增量更新，以后每次改内容都要重新拖一遍全部文件。

### 两种网址形式都支持

- 仓库名是 `用户名.github.io` → `https://用户名.github.io/`
- 其他仓库名 → `https://用户名.github.io/仓库名/`

项目全部使用**相对路径**，所以放在子目录下也不会出现图片、样式、视频失效的问题。

---

## 四、文件说明

```
index.html 等          ← 自动生成的网页，不用手改
site.config.json       ← 站点名称、联系方式等总配置
content/
  index.md             ← 首页自我介绍
  about.md             ← 关于我
  photos.md            ← 相册页的说明文字（可选）
  videos.md            ← 视频列表（可用本地文件或 B 站链接）
  music-list.json      ← 「音乐」页的网易云歌单（歌曲 ID + 歌名歌手）
  posts/               ← 所有文章（一篇一个 .md）
  photos/              ← 相册图片（放进来就会被展示）
  music/               ← 音乐文件（右上角播放器的曲目）
  media/               ← 本地视频文件
assets/
  style.css            ← 样式（配色、字体、布局）
  app.js               ← 相册灯箱等交互
  player.js            ← 全站音乐播放器（单例，所有页面共用）
  page-music.js        ← 「音乐」页的界面逻辑
  avatar.jpg           ← 头像
  favicon.png          ← 标签页图标
  video/               ← 站内视频与封面
  music/               ← 从音频 ID3 标签里提取的封面
build/
  build.js             ← 生成器：Markdown / ID3 → 网页
  serve.js             ← 本地预览服务器（支持 --watch 自动重建）
  video.ps1            ← 视频转码（H.264 + faststart）
  new-post.ps1         ← 新建文章骨架
  deploy.ps1           ← 一键发布到 GitHub Pages
.github/workflows/
  deploy.yml           ← 自动部署到 GitHub Pages
```

## 五、常见问题

**生成后网页没变化？**
先运行 `node build/build.js`，再刷新浏览器（`Ctrl + F5` 强制刷新）。

**提示 `node 不是内部或外部命令`？**
没有安装 Node.js，去 https://nodejs.org 下载 LTS 版本安装后重开终端。

**文章网址里有中文，可以吗？**
可以，但想更通用的话在文件开头加 `slug: english-name`。

**端口 5173 被占用？**
换一个：`node build/serve.js 8080`。

**GitHub 用户名为什么不能用中文？**
GitHub 的账号名只允许英文字母、数字和连字符。中文昵称可以填在个人资料的 Name 字段里，
但登录名和网址必须是 ASCII，例如 `ningzi211`。

**推送时提示文件太大？**
GitHub 单文件上限 100 MB。项目里的视频已经压到 61 MB，正常没问题。
如果以后加大视频，先跑 `build/video.ps1` 压缩，或者直接嵌 B 站链接（不占仓库空间）。

**网站能放有版权的音乐吗？**
不能。放自己的作品、有授权的曲子、或明确标注免费使用的音乐；
别人的商业音乐即使标注「仅供学习交流」也属于未授权传播，有被投诉下架的风险。
**浏览器提示"不安全"或样式丢失？**
检查仓库里是否有 `.nojekyll` 文件（它让 GitHub 不忽略特殊文件），以及 `Settings → Pages`
的 Source 是否选的是 **GitHub Actions**。
