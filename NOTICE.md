# 第三方代码与署名

本插件是**独立实现**的 DSH 插件，但在架构与若干抗坑做法上明确参考/继承了下面的项目， 按各自的许可证署名如下。

## dsh-bili-scroll（MIT）

- 项目：[https://github.com/c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)

- 版权：Copyright (c) 2026 c1overzz

- 许可证：**MIT**（本项目同样以 MIT 发布）

- 用到/继承的部分： DSH 插件的双半端结构（host `index.js` + client 自注册脚本 + `cordis.patch.yml` bundle 声明）；

- `lib/hostdeps.mjs`：**从宿主那棵树解析 `@deepseek-ai/*`，拿不到就降级**—— 这条是该项目在桌面版 DSH 上"整条插件静默不激活"的真机事故里换来的，本插件按其思路重写并保留署名；

- "跑一轮 = `dsh --profile headless ` + 一次性 overlay"的做法；

- 值班轮工具白名单（MCP 里不注册 = 模型连名字都看不到）的安全设计；

- 谷时窗口口径（工作日 9–12 / 14–18 为高峰，其余含周末为谷时）；

- 定时器回调必须自兜异常、日志必须轮转、报告缺失时补占位 等一批工程规矩。

## Chrome DevTools Protocol

- 数据抓取与截帧走 CDP，**不引入 playwright / puppeteer**（不下载 Chromium，用机器上现成的 Edge / Chrome）。

- 协议文档：[https://chromedevtools.github.io/devtools-protocol/](https://chromedevtools.github.io/devtools-protocol/)

## Windows.Media.Ocr

- 画面文字识别用 Windows 系统自带的 OCR（WinRT），零安装依赖；无中文语言包时静默降级。

## 数据来源声明

- 本插件只读取使用者**本人账号**在抖音网页版可见的内容（推荐流 / 搜索 / 关注 / 热榜 / 指定博主公开作品）。

- 不使用任何第三方爬库，不绕过登录鉴权以外的访问控制；写操作（收藏、评论）默认全部关闭， 且只有使用者自己开启后才会执行。

