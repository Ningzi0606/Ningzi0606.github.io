---
title: 视频
---

这里放我剪过的视频，点开就能看。

::video[assets/video/luna.mp4]{poster="assets/video/luna-poster.jpg" title="两分钟感受一下露娜的游刃有余！！！"}

> 这段视频是从 B 站取下的 1080P60 原档（AVC + AAC），已转成站内直接播放，不依赖平台播放器。

## 加新视频

把 B 站链接填进 [] 里即可，链接会自动识别成播放器；YouTube 链接同样支持。

```
::video[粘贴视频链接]{title="视频标题"}
```

## 放本地视频文件

1. 把视频文件放进 `content/media/` 文件夹（`.mp4` / `.webm` / `.mov`）
2. 在下面加一行，把地址换成本地文件路径：

```
::video[content/media/我的视频.mp4]{poster="content/photos/01-example.svg" title="视频标题"}
```

`poster` 是播放前显示的封面图，`title` 是视频下方的说明，都可以省略。

> 改完运行一次 `node build/build.js`，或者用 `node build/serve.js --watch` 启动预览，存盘就会自动重建。
