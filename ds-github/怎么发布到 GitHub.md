# 怎么发布到 GitHub

这个目录（`ds-github\`）已经是一个**可以直接推上去的仓库雏形**。下面是照着做就行的步骤。

## 0. 推之前先跑一遍自检

```powershell
node 发布前自检.mjs
```

它会把三个包解开，跟 `dsh-douyin-scroll\` 源码逐文件比 SHA256，并检查：链接是否可达、有没有混进个人截图、版本号是否一致、有没有残留个人路径/昵称。全绿了再推。

## 0.1 先看清目录里有什么

```
ds-github\
├─ dsh-douyin-scroll\          ← 插件源码目录（要被推上去的主体）
├─ dsh-douyin-scroll-1.4.14.tgz      ← 装插件用的 tarball（发 Release，不进 git）
├─ dsh-douyin-scroll-1.4.14-clean.zip   ← 小白包（发 Release，不进 git）
├─ dsh-douyin-scroll-1.4.14-full-clean.zip ← 脱敏完整版（发 Release，不进 git）
├─ 一键装到本机.cmd / 怎么装.md        ← 给用户看的（可以一起推）
├─ .gitignore
└─ 怎么发布到 GitHub.md（本文件）
```

> 想推的是 `dsh-douyin-scroll\` 里的东西，但要让它成为**仓库根目录**（GitHub 上打开仓库就看见 `package.json`、`index.js`），所以下一步是把里面的内容提到 `ds-github\` 根上，或者直接用 `dsh-douyin-scroll\` 当仓库根。

## 1. 建仓库（二选一）

**A. 网页建**：GitHub → New repository → 名字 `dsh-douyin-scroll` → 不要勾 README（避免冲突）→ Create。

**B. 命令行建**（有 `gh` 的话最省事）：
```powershell
gh repo create dsh-douyin-scroll --public --source . --push
```
没装 `gh` 就用 A。

## 2. 让仓库根 = 插件目录

```powershell
# 把 .gitignore 和发布说明放进插件目录，然后用它当仓库根
Copy-Item .gitignore, '怎么发布到 GitHub.md' -Destination .\dsh-douyin-scroll\ -Force
cd .\dsh-douyin-scroll
```

## 3. 初始化并提交

```powershell
git init -b main
git add .
git commit -m "dsh-douyin-scroll 1.4.14：每日刷抖音 → 日报 + 评论@ + 分享"
git remote add origin https://github.com/<你的用户名>/dsh-douyin-scroll.git
```

> 本机 git 是 MinGit，之前遇到过 schannel 吊销检查报错，如果 `push` 报 `CRYPT_E_REVOCATION_OFFLINE`：
> ```powershell
> git config --global http.sslBackend openssl
> ```

## 4. 推送

```powershell
git push -u origin main
```

HTTPS 推要 Personal Access Token（`repo` 权限）当密码；也可以先 `gh auth login` 再推。

## 5. 发 Release（放三个包）

```powershell
git tag -a v1.4.14 -m "1.4.14"
git push origin v1.4.14
```
然后网页上 Releases → Draft a new release → 选 `v1.4.14` → 把三个包拖进 assets：
- `dsh-douyin-scroll-1.4.14.tgz`（给会 `/plugin` 的人）
- `dsh-douyin-scroll-1.4.14-clean.zip`（给只想解压即用的人）
- `dsh-douyin-scroll-1.4.14-full-clean.zip`（含备份与开发计划的完整版）

有 `gh` 的话一条命令：
```powershell
gh release create v1.4.14 dsh-douyin-scroll-1.4.14.tgz dsh-douyin-scroll-1.4.14-clean.zip dsh-douyin-scroll-1.4.14-full-clean.zip --title "1.4.14" --notes-file CHANGELOG.md
```

## 6. 别人怎么装

装插件的地方（`dsh plugin`）支持三种来源，README 里已经写了：

```powershell
# ① 从 GitHub 装（推荐，能跟版本）
dsh plugin --profile desktop add github:<用户名>/dsh-douyin-scroll

# ② 装本地 tarball
dsh plugin --profile desktop add .\dsh-douyin-scroll-1.4.14.tgz

# ③ 本地源码开发
dsh plugin --profile desktop add link:D:\path\to\dsh-douyin-scroll
```

**装完必须重启 DSH**（bundle 层启动时组装），然后：设置 → 刷抖音 → 登录抖音 → 测一下 → 现在跑一轮。

## 7. 发布前自查（都已替你过了一遍）

- [x] `LICENSE`（MIT）、`NOTICE.md`、`README.md`、`CHANGELOG.md` 都在
- [x] `package.json` 无 BOM、`version: 1.4.14`、`files` 字段齐全
- [x] 全树 js/mjs 过 `node --check`
- [x] 无个人路径/昵称（`19710`、好友名、群名已洗）
- [x] `.gitignore` 排除 `node_modules/`、`.bak-*/`、`*.log`、`.probe/`、发布物（zip/tgz）

## 8. 推上去之后建议再做三件小事

1. **README 顶部加一句免责**：「仅供个人学习，自动化操作可能违反平台协议，账号风险自负」——已写在 README 里，保持。
2. **开 Issues 模板**（可选）：一个问题模板 + 一个功能请求模板，省得别人只发「不工作」。
3. **打 `good first issue` 标签**：把「视觉多待选位」「评分制挑选」这类计划项拆成 issue，比写在 CHANGELOG 里更显眼。
