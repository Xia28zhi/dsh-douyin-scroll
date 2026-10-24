# 刷抖音 · dsh-douyin-scroll

[![release](https://img.shields.io/github/v/release/Xia28zhi/dsh-douyin-scroll?label=release&color=blue)](https://github.com/Xia28zhi/dsh-douyin-scroll/releases)
[![license](https://img.shields.io/github/license/Xia28zhi/dsh-douyin-scroll)](./LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.1.7-555)](#装)
[![node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)](https://nodejs.org/)

> DSH 插件：每天替你刷一轮抖音 —— 按关键词 / 关注 / 热榜 / 指定博主去刷，**截画面看内容**，挑出值得的写成日报。 你收到的每一条，都是它先看过一遍的。

**先看三行**

- 需要机器上有个 **Edge 或 Chrome**（不下载 Chromium，也不装 playwright），以及 **dsh ≥ 0.1.7**。

- 装完**必须重启一次 dsh**（插件在 bundle 层组装）；然后进 **设置 → 刷抖音** 点一次「登录抖音」。

- 会动你账号的（自动收藏、评论 @ 你）**默认全关**；要花钱的（视觉模型）**默认关**。

---
## 它做什么

**去哪刷**（设置页可开关，可多选）

| 来源 | 说明 |
| --- | --- |
| 关键词搜索 | 按你填的词搜最近作品；留空用默认组（AI / 编程 / 效率工具 / 摄影 / 健身） |
| 关注列表 | 你关注的人最近发了什么 |
| 热榜 | 今天什么在火，挑相关的词再搜下去 |
| 指定博主 | 填主页链接，逐个看新作品 |
| 推荐流 | 抖音推给你的（默认关） |

**怎么判**（三层，逐层加码）

1. **元数据**：标题 / 文案 / 话题 / 作者 / 时长 / 点赞评论收藏数 —— 快筛，广告标题党直接跳。
2. **画面文字（OCR）**：抖音**没有字幕接口**，画面里的字常常就是这条视频的全部信息。用 Windows 自带 OCR，零依赖。
3. **画面理解（视觉模型，可选）**：填一个多模态接口让它"看图说话"。⚠️ 默认模型 `deepseek-flash` 是纯文本的、看不了图，所以这一层**由插件在宿主侧把画面翻译成文字**再交给值班模型 —— 模型换谁来都跑得动。
**产出什么**

- `out/<日期>.md` 日报：每条含「为什么值得」+「它自己的一句话」+「画面里看到的」+ 链接。

  长这样（示例，内容是编的，格式是真的）：

  ```markdown
  ## 今天刷了 34 条，挑出 3 条

  ### 74xxxxxxxxxxxxxxxx · 用 200 行把 CDP 玩明白了
  **作者** 某某 · 06:12 · ❤ 1.2万 💬 340 ⭐ 890

  - **为什么值得**：把协议层讲清楚了，不是念文档。
  - **它自己的一句话**：「你不需要 playwright，浏览器本来就是可以被远程操控的。」
  - **画面里看到的**：白板画了 WebSocket 帧结构，讲了 Target 和 Session 的关系。
  - https://www.douyin.com/video/74xxxxxxxxxxxxxxxx
  ```

- 可选**自动收藏**、可选**评论 @ 你**（都要你自己开）。

**什么时候跑**：谷时自动（工作日 12–14 点、18 点后及整个周末）／每日固定时间／开 dsh 时补跑／设置页「现在跑一轮」。

---
## 装

三种，选一种。装完**一定重启一次 dsh**，设置页里才会出现「刷抖音」。

| 你手上是什么 | 命令 |
| --- | --- |
| 想直接装最新版 | `dsh plugin --profile desktop add github:Xia28zhi/dsh-douyin-scroll` |
| 从 Release 下了 `dsh-douyin-scroll-1.4.14.tgz`（推荐，最稳） | `dsh plugin --profile desktop add "E:\完整路径\dsh-douyin-scroll-1.4.14.tgz" --registry=https://registry.npmmirror.com` |
| 下了 `*-clean.zip`，或想改代码 | 解压出 `dsh-douyin-scroll\` 目录，再 `dsh plugin --profile desktop add link:"E:\完整路径\dsh-douyin-scroll"` |

> `--profile` 换成你**真在用**的那个（桌面版一般就是 `desktop`，老版 Web 是 `web`）。`link:` 指向目录，**别删那个目录**。
> 国内拉依赖要带 `--registry=https://registry.npmmirror.com`。
> 更细的说明（含「只有 zip 没有命令行」「一键装 .cmd」「卸载」）：见 [INSTALL-怎么装.md](./INSTALL-怎么装.md)。

进 **设置 → 刷抖音**：

1. **登录抖音** —— 点一下会开一个浏览器窗口，在里面扫码。登录态存在插件自己的浏览器 profile 里， 跟你现在用的浏览器完全隔离，重启也在。
2. **测一下** —— 它会真跑一遍：登录 → 搜索 → 热榜 → 关注 → 截帧，直接回答"能不能用"。
3. 勾上想刷的来源、定好每天挑几条，然后点**现在跑一轮**。
---
## 它是怎么干活的（想改代码看这里）

```
  ```
  host（插件本体）                值班那一轮（headless 会话）
  ├─ 养一台浏览器（Edge/Chrome + CDP）      │
  ├─ 定时器：谷时 / 每日 / 开 dsh 补跑      │  spawn dsh --profile headless --patch overlay <prompt>
  ├─ HTTP /api/douyin-duty/*（设置页）      │           │
  └─ 一轮结束后：按 picks.json 收藏/评论 ────┼───────────┴─ overlay 挂 @deepseek-ai/dsh-mcp-client
                                           │              └─ 起 lib/mcp-server.mjs（本插件自带）
                                           └─ 模型手里的 12 个工具全从这里来
  ```
```

- **不用签名**：在已登录的页面上下文里 `fetch` 同源接口就能拿到数据（实测 `search/item`、`tab/feed`、 `aweme/post`、`aweme/detail`、`follow/feed`、`hot/search/list` 全部 `status_code=0`）。 不去逆向 a\_bogus，也不引 playwright —— 数据层和截帧都走 CDP。

- **模型没有"收藏 / 评论"这两只手**：MCP 工具白名单里就没注册，它连名字都看不到。 真动手的是**宿主**，在一轮结束后按 `picks.json` + 开关执行，条数由上限说了算。

### 目录

| 文件 | 职责 |
| --- | --- |
| `index.js` | host 半端：配置、HTTP 接口、定时器、跑一轮、一轮后的收藏/评论 |
| `client.js` | 浏览器半端：设置页那一页 |
| `lib/cdp.mjs` | 极简 CDP 客户端（Node 22 自带 WebSocket，零依赖） |
| `lib/browser.mjs` | 浏览器会话（一台常驻、独立 profile） |
| `lib/douyin.mjs` | 数据层：各来源抓取 + 截帧 |
| `lib/ocr.mjs` | Windows 内置 OCR |
| `lib/vision.mjs` | 视觉模型（OpenAI 兼容接口） |
| `lib/act.mjs` | 收藏 / 评论（默认关，走真实 UI 点击） |
| `lib/mcp-server.mjs` | 给值班那一轮的 MCP 服务端（工具白名单 = 安全边界） |
| `prompts/duty.md` | 值班章程（判定口径 + 红线），**你可以改**，改了不会被覆盖 |

### 数据都在哪

`$DSH_HOME/douyin-duty/`：`config.json`（配置权威）/ `state.json` / `seen.json` / `picks.json` / `out/<日期>.md` / `frames/` / `duty.md` / `duty.log` / `browser/`（浏览器 profile）。 **不写进插件包目录**。

### 不装 dsh 也能验

```bash
  ```bash
  node tools/selftest.mjs     # 起浏览器 → 查登录 → 挨个跑接口 → 截一帧
  node tools/mcp-probe.mjs    # 真跑一遍 MCP 服务端（模拟值班那一轮拿工具）
  ```
```

---
## 已知边界

- **抖音随时可能改版 / 加风控**。哪天某个来源失效了，`duty.log` 和「测一下」会先告诉你，不是静默失败。

- **截帧是真播一遍视频**，一条 15–20 秒。所以只对过了快筛的用，一轮别超过十条。

- **视觉模型要花钱**，按张计费；不开也能跑（靠元数据 + OCR）。

- 收藏 / 评论靠**真实 UI 点击**，抖音改版后可能点不到 —— 失败了会写进日志，不会自作主张重试。 ⚠️ 第一次建议先不开，等你看过两轮日报的风格再决定。

## 许可证

MIT。架构与若干抗坑做法参考了 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（同为 MIT）， 详见 `NOTICE.md`。
---

## 免责

这是**个人自用的自动化小工具**，不是官方产品。它通过你本机的浏览器去操作抖音网页版，因此：

- 可能违反抖音的用户协议，**账号风险（限流、验证码、封禁）由使用者自负**；
- 会动你账号的功能（自动收藏、评论带 @、分享给好友/群）**默认全关**，开了就是拿你的号在说话，请自己掂量；
- 视觉模型那层要花钱且会把画面发给第三方接口，默认关闭；
- 代码按 MIT 提供，**不含任何担保**。

本仓库不含任何账号数据；$DSH_HOME/douyin-duty/ 里的登录态、日报、发件账本都在你机器上，不会自动上传。