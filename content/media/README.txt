这个文件夹用来放本地视频文件（.mp4 / .webm / .mov）。

【如果你是从 B 站下载的原片】
1. 把下载好的文件放进这个文件夹
2. 运行转码脚本（会自动找这个文件夹里最大的视频文件）：
       powershell -ExecutionPolicy Bypass -File build\video.ps1
   也可以指定文件和画质：
       powershell -ExecutionPolicy Bypass -File build\video.ps1 -Source "下载路径\luna.mp4" -Crf 20
3. 转码结果会输出到 assets\video\，然后在 content\videos.md 里引用它

【直接在 videos.md 里引用】
    ::video[assets/video/luna.mp4]{title="视频标题"}

说明：
- 建议单个文件不超过 95 MB，GitHub 单文件硬上限是 100 MB
- 大视频更推荐直接嵌 B 站链接（::video[B站链接]），不占你自己的仓库空间
- 不想把视频提交到 Git，可以在 .gitignore 里排除 content/media/*.mp4
