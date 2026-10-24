# 装之前先看这三行

1. 需要 **DSH 桌面版**（≥ 0.1.7）和 **Edge 或 Chrome**（有一个就行；不用装 Chromium、不用装 playwright）。
2. 装上之后 **必须重启一次 DSH**，否则设置里根本不会出现「刷抖音」。
3. 第一次用要**扫码登录**抖音，那一轮的"登录态"存在 `$DSH_HOME/douyin-duty/browser/`，以后不用再登。

---

## 一、装

把这个 `dsh-douyin-scroll` 文件夹放到一个**不会被挪走**的地方（比如 `D:\plugins\dsh-douyin-scroll`），然后在命令行里：

```bat
dsh plugin --profile desktop add link:D:\plugins\dsh-douyin-scroll
```

> `--profile` 后面填你**真正在用的**那个 profile（桌面版一般是 `desktop`；不确定就先 `dsh plugin --profile desktop list` 看看有没有别的）。
> 国内网络如果卡在 pnpm 拉包上，加一句 `--registry=https://registry.npmmirror.com`。

装完 **重启 DSH**。

## 二、第一次跑

1. 打开 **设置 → 刷抖音**。
2. 点 **「登录抖音」** —— 会开一个浏览器窗口，在里面扫码登录（这个窗口别手动关，插件要靠它）。
3. 点 **「测一下」** —— 它会真跑一遍：登录 / 搜索 / 热榜 / 关注 / 截帧，最后告诉你哪一项不行。
4. 在「偏好」里填 **关键词**（一行一个，`,` `、` `/` 空格都能分隔），勾上要的来源。
5. 回「日常」点 **「现在跑一轮」**，跑完 `$DSH_HOME/douyin-duty/out/<日期>.md` 就是日报。

## 三、默认关着的那几个开关（别急着开）

| 开关 | 为什么默认关 |
| --- | --- |
| 自动收藏 | 会动你的账号 |
| 评论 / @ 某人 | 会**替你说话**，而且发出去就撤不回 |
| 私聊 / 群分享 | 同上，而且是发给别人的 |

要用就自己开，并且先想清楚「一天最多几条」。想让它只把草稿写进「待发件箱」由你批准，就把 **发件模式** 设成 `review`（默认就是这个）。

视觉模型那一栏可以**留空**：留空就走本机 OCR + 页面文字，不花钱；要填就填 OpenAI 兼容接口（如智谱 `https://open.bigmodel.cn/api/paas/v4`）+ key + 模型名。

## 四、数据在哪 / 怎么卸

- 数据（配置、日报、截图、待发件箱、登录态）：`$DSH_HOME/douyin-duty/`（Windows 一般是 `C:\Users\<你>\.dsh\douyin-duty`）。删掉这个目录 = 回到全新。
- 卸载：`dsh plugin --profile desktop remove dsh-douyin-scroll`，再删掉上面那个数据目录。

有问题先看 `$DSH_HOME/douyin-duty/duty.log` 的最后几十行，那里写得比界面上细。
