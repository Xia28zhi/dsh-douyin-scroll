# 怎么装（三种，选一种就行）

装之前先确认两件事：**DSH 桌面版 ≥ 0.1.7**，机器上有 **Edge 或 Chrome**（有一个就行；不用装 Chromium、不用装 playwright）。

装完**一定要重启一次 dsh**，设置页里才会出现「刷抖音」。

## Release 页面上的附件都是什么

| 附件 | 是什么 | 给谁 |
| --- | --- | --- |
| `dsh-douyin-scroll-1.4.14.tgz` | npm 风格 tarball（108 KB，里面是 `package/…`） | **装插件最稳的一种，推荐** |
| `dsh-douyin-scroll-1.4.14-clean.zip` | 脱敏源码包（30 个文件，含 `docs/` 踩坑记录 + `proof/` 证据脚本） | 想读代码 / 发给别人 |
| `dsh-douyin-scroll-1.4.14-full-clean.zip` | 脱敏完整版（46 个文件：上面这些 + 两个旧版备份目录） | 自己备份 / 换机 / 看完整结构 |
| `install-one-click.cmd` | 双击就装（走下面 ②） | 懒人 / 不想敲命令 |

> ⚠️ 同一台机器**别装两遍**：插件 id 是 `dsh-douyin-scroll`，装第二份会顶掉第一份（配置和日报不受影响，它们在 `$DSH_HOME/douyin-duty`）。

> `Source code (zip / tar.gz)` 是 GitHub 自动打包的**仓库源码**，跟上面的 tgz 不是一回事，别拿它当安装包。

---

## ① 从 GitHub 直接装（最省事）

```bat
dsh plugin --profile desktop add github:Xia28zhi/dsh-douyin-scroll
```

需要机器上有 `git`；没有 git 就用 ② 或 ③。

## ② 用下载的 tarball 装（推荐，不依赖 git）

```bat
dsh plugin --profile desktop add "E:\完整路径\dsh-douyin-scroll-1.4.14.tgz" --registry=https://registry.npmmirror.com
```

`--profile` 填你**真在用的**那个（桌面版一般就是 `desktop`，老版 Web 是 `web`）。
国内拉依赖要带 `--registry=https://registry.npmmirror.com`，否则会卡在 npm 官方源。

## ③ 用目录装（想改代码走这个）

```bat
dsh plugin --profile desktop add link:"E:\完整路径\dsh-douyin-scroll" --registry=https://registry.npmmirror.com
```

`link:` 是指向目录的，**别删这个目录**，删了插件就没了。
只拿到 `.zip`、又不想用命令行的，先解压成 `dsh-douyin-scroll\` 目录，再按这条装。

---

## 一键装（Windows）

把 `install-one-click.cmd` 和 `dsh-douyin-scroll-1.4.14.tgz` **放在同一个目录**，双击 `.cmd` 即可。
也可以把 tgz **直接拖到 `.cmd` 上**；脚本还会在「同目录 → 上级目录 → 下载 → 桌面」里自动找 `dsh-douyin-scroll-*.tgz`。
它会：找包 → 检查 PATH 里有没有 `dsh` → 按 profile `desktop` 装 → 提示你重启。
如果提示「PATH 里没有 dsh」，脚本会把完整的绝对路径命令打出来，复制执行就行。

---

## 装完第一次怎么用

1. **重启 DSH**（不重启，设置里不会出现「刷抖音」）。
2. 设置 → **刷抖音** → 点「**登录抖音**」，在弹出来的浏览器里扫码（登录态存在 `$DSH_HOME/douyin-duty/browser/`，以后不用再登）。
3. 点「**测一下**」，它会真跑一遍登录 / 搜索 / 热榜 / 关注 / 截帧，直接告诉你行不行。
4. 「偏好」里填关键词、勾来源；回「日常」点「**现在跑一轮**」。
5. 日报在 `$DSH_HOME/douyin-duty/out/<日期>.md`。

默认关着：自动收藏、评论 @、私聊、群分享 —— 这些是**拿你的号说话**，要开自己开。

## 卸载

```bat
dsh plugin --profile desktop remove dsh-douyin-scroll --config.registry=https://registry.npmmirror.com
```

再删 `$DSH_HOME/douyin-duty` 就是回到全新。
