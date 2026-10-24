# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-douyin-scroll`（中文名「**刷抖音**」）：每天替用户刷一轮抖音 —— 按关键词 / 关注 / 热榜 / 指定博主去刷， **截画面看内容**（抖音没有字幕接口），挑出值得的写成日报。

## 帮用户安装时，按这个顺序

1. **前提**：机器上有 **Edge 或 Chrome**（有一个就行），以及 **dsh ≥ 0.1.7**。 不下载 Chromium、不装 playwright —— 数据抓取和截帧都走 **CDP**。
2. `dsh plugin --profile web add link:<本目录>`（本地开发） 或 `dsh plugin --profile web add github:<仓库>`（分发）。 ⚠️ 桌面版 DSH（NEXT / 0.2.x）把 `web` 换成用户自己在用的 profile（常见是 `desktop`）。
3. ⚠️ **必须重启一次 dsh**（bundle 层要重启才组装），否则设置页里根本没有「刷抖音」。
4. 进 **设置 → 刷抖音**：点「**登录抖音**」（会开一个浏览器窗口，让用户在里面扫码） → 点「**测一下**」自检（真跑一遍登录/搜索/热榜/关注/截帧，直接回答能不能用） → 勾来源 → 点「**现在跑一轮**」。
5. **别擅自打开「自动收藏」和「评论 @ 你」** —— 那是拿用户的号说话。要用，得用户自己开。
## 排错（按症状找）

| 症状 | 先看哪儿 |
| --- | --- |
| 设置页里没有「刷抖音」 | 没重启 dsh；或装到了别的 profile（用 `--profile` 指定用户真在用的那个） |
| 「测一下」登录是 ✗ | 浏览器窗口里没登/掉了；重开窗口扫码（登录态在 `$DSH_HOME/douyin-duty/browser/`） |
| 搜索/热榜是 ✗ 但登录 ✓ | 多数是掉登录或触发风控；等一会儿再试，看 `duty.log` |
| 截帧 ✗ | 视频下架 / 页面结构变了；`duty.log` 里有具体报错 |
| 一轮跑完 `out/` 空的 | 看 `duty.log` 尾部；插件会补一份占位报告说明退出的原因 |
| 那一轮 0.17 秒就结束、什么都没干 | 桌面版 Electron 里 spawn 的 node 少了 `ELECTRON_RUN_AS_NODE`（已处理）；还不行就在设置页填 `dshBin` |

`duty.log` 在家目录里，**超过 2MB 会自动滚到 `duty.log.1`**。

## 仓库结构（改代码时看这里）

- `index.js` —— host 半端：配置（`config.json` 是**权威**）/ HTTP 接口 / 三种定时 / 跑一轮 / 收藏与评论

- `client.js` —— 浏览器半端：设置页那一页（`slots.inject('settings.section', …)`）

- `lib/cdp.mjs` —— 极简 CDP 客户端（**零 npm 依赖**，Node 22 自带 `WebSocket`）

- `lib/browser.mjs` —— 常驻浏览器会话（独立 `user-data-dir`，登录态长期留着）

- `lib/douyin.mjs` —— 数据层：五个来源 + 截帧（**接口不用自己签名**，在页面上下文里 fetch 即可）

- `lib/ocr.mjs` —— Windows 内置 OCR（WinRT）；中文路径要**先复制到英文临时路径**

- `lib/vision.mjs` —— 视觉模型（OpenAI 兼容）；默认模型看不了图，**这一层负责把画面翻成文字**

- `lib/act.mjs` —— 收藏 / 评论（默认关，走真实 UI 点击；评论支持真 @）

- `lib/outbox.mjs` —— 对外发言的待发件箱（评论 @ / 私聊 / 群）；**模型只能写草稿，发不出去**

- `lib/mcp-server.mjs` —— 值班那一轮的 MCP 服务端；**工具白名单就是安全边界**

- `prompts/duty.md` —— 值班章程（判定口径 + 红线）；用户改过的**不会被覆盖**

## 约定

- 配置与运行数据都在用户的 `$DSH_HOME/douyin-duty/`，**不写进插件包目录**。

- 谷时口径：工作日 9–12 / 14–18 是高峰，其余（含整个周末）都是谷时。

- **任何定时器回调、任何写文件都要自己 try/catch 兜住** —— 插件再错也只该"这一轮没跑成"， 绝不该把 DSH 宿主带走（这条来自 dsh-bili-scroll 的真机事故）。

- **别裸 import `@deepseek-ai/*`**（桌面版不装 optional peer ⇒ 整条插件静默不激活）， 一律走 `lib/hostdeps.mjs`。

