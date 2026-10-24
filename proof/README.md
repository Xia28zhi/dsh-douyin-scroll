# proof/ —— 真机证据脚本

这三个脚本不是测试用例，是**可复跑的现场勘察工具**。改选择器之前先跑它们，比猜快。

| 脚本 | 干什么 | 怎么跑 |
| --- | --- | --- |
| `probe-dom.mjs` | 打印插件依赖的每个 DOM 事实（评论框、@ 下拉、分享图标尺寸…） | `node proof/probe-dom.mjs <视频URL>` |
| `verify-comment.mjs` | 用插件自己的 `lib/act.mjs` 真发一条带 @ 的评论，返回 `mention: real/plain` | `node proof/verify-comment.mjs <视频id> <@谁> "正文"` |
| `verify-share.mjs` | 真把视频卡片分享给某个人/某个群 | `node proof/verify-share.mjs <视频id> <分享给谁>` |

共同前提：

1. 浏览器已登录抖音 —— 在设置页点「**登录抖音**」扫码，登录态存在 `$DSH_HOME/douyin-duty/browser`。
2. 环境变量（不设就按默认 `~/.dsh/douyin-duty`、端口 9333）：
   ```powershell
   set DOUYIN_DUTY_HOME=C:\Users\你\.dsh\douyin-duty
   set DOUYIN_CDP_PORT=9333
   ```
3. 如果 Edge/Chrome 已经是**提权**进程，普通权限起不起来会被拦 —— 那就直接连它已开的端口（脚本里 `port` 已给）。

结论都记在 [`../docs/踩坑记录.md`](../docs/踩坑记录.md)。
