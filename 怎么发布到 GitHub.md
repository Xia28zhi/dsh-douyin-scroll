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
├─ install-one-click.cmd / 怎么装.md        ← 给用户看的（可以一起推）
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
git remote add origin https://github.com/Xia28zhi/dsh-douyin-scroll.git
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
dsh plugin --profile desktop add github:Xia28zhi/dsh-douyin-scroll

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

---

# 9. 发第二版（以后每次发版都照这个顺序）

上面第 1–5 节讲的是**首次**发布。之后再发版，顺序不能乱，下面每一条都是踩过的坑。

## 9.1 五步

```powershell
# ① 改代码 + 改版本号（package.json 的 version）+ 写 CHANGELOG.md 顶部一节
# ② 先提交、先推 main
git add -A
git commit -m "1.4.15：……"
git push

# ③ 从 HEAD 重新打包（别用旧包！）
#    注意：排除 docs/images 和 .gitignore，否则包会从 115KB 涨到 3MB
tar -czf dsh-douyin-scroll-1.4.15.tgz -C .stage package
tar -a -cf dsh-douyin-scroll-1.4.15-clean.zip -C .stage dsh-douyin-scroll
# ④ tag 一定在 push main 之后打
git tag v1.4.15
git push origin v1.4.15
# ⑤ 网页 Releases → Draft a new release → 选 v1.4.15 → 拖附件 → 正文写清这版改了什么
```

## 9.2 四条铁律

1. **已经发布过的 tag 不要 `push -f` 重写。**
   挪 tag 会让 Release 指向别的提交，附件位置/说明会错乱（真机上就这么丢过一次附件）。文档小改就**只推 main**，不碰 tag。

2. **附件名用 ASCII。**
   中文名的附件（比如 `一键装到本机.cmd`）传上去会被 GitHub 改叫 `default.cmd`，于是正文里写的文件名和实际对不上。所以脚本叫 `install-one-click.cmd`。

3. **同一个 Release 里不能有同名附件。**
   想换包必须先点右侧 **×** 删掉旧的，再传新的；否则页面只给一句 `Something went really wrong, and we can't process that file.`（不是网络问题，是重名）。

4. **附件跟着代码走。**
   只要源码/文档变了就重新打包；包里的 `INSTALL-怎么装.md`、`README.md` 是打进包里的，不重打就会出现「下载的包里文档是旧的」。

## 9.3 发完怎么验（三条命令，别靠眼睛）

```powershell
# ① 远端 main / tag 是否指向你刚推的提交
git ls-remote origin main refs/tags/v1.4.15

# ② 附件列表 + 每个附件的 sha256（GitHub 自己算的）
#    把返回里的 digest 和本地 (Get-FileHash 文件 -Algorithm SHA256).Hash 对比
curl "https://api.github.com/repos/Xia28zhi/dsh-douyin-scroll/releases/expanded_assets/v1.4.15"

# ③ 这版是不是「最新版本」
curl "https://api.github.com/repos/Xia28zhi/dsh-douyin-scroll/releases/latest"
```

**正文里的命令块别手敲**：从 `INSTALL-怎么装.md` 里整段复制，避免出现 `--profile` 被写成「--配置文件」这种（浏览器页面翻译也会造成这种错觉，存进去的内容是好的，Ctrl+点翻译图标关掉即可）。

## 9.4 小抄：本地路径

| 东西 | 位置 |
| --- | --- |
| 仓库（也是要上传的源码） | `E:\AI生成产物、新建任务和工作空间\harness\ds-github\dsh-douyin-scroll\` |
| 发布用附件（不进 git） | `E:\AI生成产物、新建任务和工作空间\harness\ds-github\` |
| 运行中的插件（真机在用的） | `E:\DeepseekHarness\plugins\dsh-douyin-scroll\` |
| 插件数据（配置/日报/待发件箱） | `$DSH_HOME\douyin-duty\` |

> 改完运行目录的代码，**必须重启一次 DSH** 才生效（host 与 client 都是启动时加载的）。
