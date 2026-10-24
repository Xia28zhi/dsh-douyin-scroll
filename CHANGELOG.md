# 1.4.14（2026-10-24）
- **修「点互动页白屏」**（主人报的）：React 的 `h(X, props, 唯一一个孩子)` 给的是**孩子本身**（不是数组），
  而 `Sec` / `Sub` 直接 `...children` 展开 ⇒ `TypeError: Spread syntax requires ...iterable[Symbol.iterator]`。
  待发件箱里**正好只有 1 条草稿**时必犯（多条时是数组，所以平时看不出来）。
  - `Sec` / `Sub` 用 `KIDS()` 归一化；白名单 / 关键词 / 视觉候选那几个 `.join()` 也用 `ARR()` 兜住（万一配置文件被人写成字符串）。
  - 新增 `Boundary` 错误边界：以后再出渲染错误，页面显示一行红字，而不是整页白掉。
  - 复现/回归手段：`.probe-at/render-real-react.mjs` 用真 React 18 的 `renderToString` 跑面板 —— 旧版 1 条草稿报同一个 TypeError，新版正常。

# 1.4.13（2026-10-24）

- **修正 1.4.12 的口径**（主人原话：「默认二选一，如能 @ 则跳过分享个人；分享群聊必备」）：
  - 有评论发出（`commentedOk > 0`）⇒ **只跳过私信（kind=dm）分享**，草稿留着下次；
  - **群分享（kind=group）不受影响**，该发还发 —— 群聊是固定动作；
  - 日志拆成两条分别说清：「私信分享：本轮已发出 N 条评论（@ 优先）…留着下次」与
    「分享：N 条在 outbox 等你批准」。
- `prompts/duty.md` 同步同一口径。

# 1.4.12（2026-10-24）

- **@ 与分享二选一，@ 优先。** 主人定的规矩：分享只发一张视频卡片、**没有总结文字**，
  所以只要这一轮有评论真发出去了，就不再分享。
  - `runActions` 里分享从「第 1 步」挪到「第 3 步」（收藏之后、评论之后），并加 `commentedOk`
    计数：`commentedOk > 0` 时跳过分享，日志写明「本轮已发出 N 条评论（@ 优先），M 条分享草稿留着下次」；
  - 一条评论都没发出去（没草稿 / 配额用完 / 评论失败）时，分享才作为兜底出场；
  - `prompts/duty.md` 加了同一条规矩给模型看：别同时写 `comment` 和 `dm`/`group` 两类草稿。

# 1.4.11（2026-10-24）

- **修复：评论区在折叠线以下时，评论永远失败。** 真机发现个别视频页重试三轮都报「没找到评论输入框」，
  单独诊断证实「点了占位文字后编辑器确实出现，只是比以前慢」。三处改动：
  1. `findBox` / `findSmallByText` 命中元素若在视口外，先 `scrollIntoView` 再算坐标
     （以前直接按越界坐标点，点到的是视频/空白处）；
  2. 新增 `findExactBox`：按**完全相等**的文字定位，「留下你的精彩评论吧」用它点，
     不再被「包含」匹配挑到内层小 span（点小 span 常常点不动）；
  3. 输入框选择器补 `.public-DraftEditor-content[contenteditable="true"]` 与
     `[contenteditable="true"]` 回退；三轮都失败时再补一次「滚到底 → 点占位文字 → 等 2.5s」。
- 真机验证：之前必失败的那个页面（7699506462728506687），现在连续两次都「已发出（页面上看到了）」。

# 1.4.10（2026-10-24）

**配额账本补账：兜底路径发的评论以前不进 outbox，`sentToday` 永远 0 ⇒ 每日评论配额等于没有。**

- 真机证据：一轮发了 4 条评论（日志逐条 `已发出`），收尾却写「今日评论已发 0 条」。
- 新增 `lib/outbox.mjs` 的 `recordSent()`：不经过草稿流程、直接发出去的那条，也往 `outbox.jsonl`
  补一条 `status:'sent'` 的账（`by:'host'`）；`runActions` 的 picks 兜底路径发成功就补。
- 抽查同时确认：`acted.json` 账本已经能写了（4 条 `commentAt` 都在），`actedFile is not defined` 已消失。

# 1.4.9（2026-10-24）

**分享（私信 / 群）真正能发了；顺序改成「先分享 → 再收藏 → 再评论 @」；顺手修掉三个真机 bug。**

- **分享**：视频页那个「分享」图标是**鼠标移上去才弹面板**的（点它没反应），
  图标 = 点赞/评论/收藏/分享那一行里**第 4 个数字左边**那个 42×42 的 svg。
  面板里的「谁」要**按同一水平线**配（每个「分享」按钮取与它 y 对齐、在它左边的短文本当名字）——
  按祖先层数取 innerText 会数成别人（真机第一次就错配成「星全、莉莉玛莲」）。
  顶部搜索框搜的是**好友库**，面板第一屏能看到的人不一定搜得到，所以先在第一屏按名字找、找不到再搜。
  真机已验证：分享给「某个好友」（私信）与「某个群」（群）→ 面板都回「已分享」。
  面板里**没有独立的「群」区**，群也是在这个列表里按名字找，找不到就如实失败、不瞎点。
- **顺序**：`runActions` 现在是 分享 → 收藏 → 评论；私信/群只发**视频卡片**，不带总结正文
  （用户口径：总结走评论区 + @，别走私信）。
- **修 `actedFile is not defined`**：动作账本一直没写进去（每轮日志都在报这个），
  现在补上 `const actedFile = join(stateDir, 'acted.json')`，一天一条视频最多收藏/评论各一次。
- **修「标签越开越多 / Edge 开太多」**：`finally` 里拿不到 `try` 里 `const { cdp }` 的变量（作用域），
  抛的 ReferenceError 被 catch 吞了 ⇒ 标签从来没关过。现在 `cdp` 提到外层声明，
  且**关最后一个标签会让整个浏览器退出**，所以只剩一个时改成导航到 `about:blank`。

# 1.4.8（2026-10-24）

**修「@ 一直是假的」：找不到下拉的选择器写错了，抖音那个好友列表根本不长在 `[class*="mention"]` 里。**

- 真机实测（无头 CDP 打到 live 视频页）：打 `@名字` 之后弹出的是 `.atBox-inner-container`，
  每个好友名字在 `span.lgAE_oZa` 里；**点中**之后编辑器里那一截才变成
  `<span class="douyin_mention_word">@名字</span>` —— 这才是抖音认的、能通知到人的真 @。
- 旧代码拿 `[class*="mention" i]` / `[role="listbox"] li` / `[class*="at-list"] li` 去等下拉，
  一个都匹配不上 ⇒ 每次都静默退回纯文本 `@名字`，所以「@ 仍然无效」。
- 现在：打 `@名字` → 等 `.atBox-inner-container` 里的候选 → 先找同名、再找前缀、再找包含、只有一个就用它
  → 点中 → **回读编辑器里有没有 `douyin_mention_word`** 来判定 `mention` 到底是 `real` 还是 `plain`（不猜）。
- 退回纯文本时也不再让正文粘在 `@` 后面（先退格删掉 `@名字`，再整体打 `@名字 正文`）。

# 1.4.7（2026-10-24）

**两件事：一轮刷多少条要有上限；值日那一轮必须真的起一个后台 dsh。**

- **扫描预算**：以前一轮能把 5 个关键词 × 10~20 条 + 关注 + 推荐全刷一遍，候选能到一百五十条 ——
  报告里「今天刷了 150 条」看着头大，扫描越密也越容易招风控。
  现在每个浏览工具的 `n` **默认 6**，整轮累计超过「每轮最多扫」（默认 60，设置页 日常 页可改）就拦住后面的刷取，
  并直接告诉模型「别再刷了，拿已经看到的收尾」。`douyin_status` 里多了 `scanned` / `scanLimit` 两个数，
  模型据此判断该收尾了。
- **值日那一轮**：以前 `dailyAt` 是**分钟字面相等**（`hhmm(now) === dailyAt`）才触发 ——
  客户端 07:31 才打开、或机器那一分钟睡眠/卡顿，这一天就静悄悄没有了。
  现在改成「到点或已过点、今天还没跑过就跑」，并且这一轮 spawn 是 **detached** 的后台进程：
  stdout/stderr 直接落到 `duty.log` 的文件描述符（父子之间不走管道），
  所以**客户端关掉/重启都不影响它跑完**。日志里会写 `（detached 后台进程）`。
  ⚠️ 客户端关掉的话，跑完之后的收藏/评论动作还是得由客户端做 —— 那是拿账号说话的活儿，
  不让它脱离客户端偷偷干。

# 1.4.6（2026-10-24）

**评论全部「没找到评论输入框」**——主人截图 + 无头 CDP 实测后定位：

- 这一版评论区是 **Draft.js**：真输入框是 `.public-DraftEditor-content[contenteditable="true"]`，
  而且**没点开之前页面上根本没有 contenteditable**，只有一句占位文字「留下你的精彩评论吧」。
  以前的 `querySelector('[contenteditable="true"]')` 必然落空 ⇒ 每轮评论全失败（日志里 6 条全挂）。
- 现在：展开面板 → **点占位文字把编辑器激活** → 再找编辑器 → 点它 → `selectAll+delete` 清残留草稿 → 输入正文。
- `@`：实测点输入框右边的 @ 图标、或直接键入 `@`，**都不弹候选浮层**（headless 下如此），
  所以照旧退成纯文本 `@名字`，并在结果里注明"可能通知不到人"。

# 1.4.5（2026-10-24）

- `douyin_status` 多返回一个 `now`（当前时间）—— 值班那轮没有 shell，之前想用 pwsh 取时间取不到，
  说明块里只能写"刚才"。现在时间直接从工具里拿。
- 章程补一条：**别为了记时间/看文件去调命令**，写不清就写"刚才"，不许编钟点。

# 1.4.4（2026-10-24）

**「浏览器窗口」设了没生效**（主人切成 headless / visible，实际行为不变）：

- 根因：`BrowserSession` 的 mode 只在第一次创建时从 `cfg.browserMode` 读一次，之后改配置不会再传下去。
  现在 `ensureDy()` 每次按**当前** cfg 算一遍要哪种窗口，`POST /config` 里改了这一项就当场 `setMode()` 切换。
- 日志里会多一句 `浏览器窗口已切到 <mode>`，能直接看出有没有真的切过去。

# 1.4.3（2026-10-24）

**「浏览器打不开」**——主人点「登录抖音」，屏幕上什么都没有（日志里还写着"已打开登录窗口"）：

- 根因：端口上占着的是**之前 headless 起的那个 Edge**，插件把它当"已开"复用了；headless 本来就没有窗口。
  现在 `BrowserSession.start()` 复用前先看 `/json/version` 的 UA，带 `Headless` 且这次要窗口（visible/hidden）
  ⇒ 用 `Browser.close` 关掉重开（不误杀主人自己的 Edge）。
- `show()` 以前只把 `windowState` 设成 `normal` ＝"还原到原来的位置"——如果原来被挪到屏幕外就还在屏幕外。
  现在还原之后再显式摆到 `(120, 80) 1200×900`。
- `/login/start` 改走 `ensureDyFresh('visible')`：登录不再复用任何现成浏览器，直接关掉重开一个真窗口。

# 1.4.2（2026-10-24）

**日报尾巴不再越堆越长**（这天被抖音风控连拦 3 轮，同一天堆了 4 段几乎一样的"没跑成"说明）：

- `douyin_report`：说明块若以 `<!-- douyin-note -->` 开头，则**整段替换旧的**（同一天只留最新一次），
  普通条目照旧追加；`prompts/duty.md` 与工具描述都写明了这个约定。
- 顺带把当天那份报告里的 4 段重复说明合成 1 段。

# 1.4.1（2026-10-24）

**真机实测驱动的修正**（用无头 CDP 打到真实登录态抖音页，只读探查、未点发送）：

- **改版选择器**：实测这一版抖音页面上 `aria-label` 全是空的，收藏按钮是 `[data-e2e="video-player-collect"]`、
  点赞是 `video-player-digg`、评论入口是 `[data-e2e="feed-comment-icon"]`、评论列表是 `comment-list`。
  旧的"靠 aria / class 猜"的写法**在真机上永远找不到**（这正是以前评论 3/3 报"没找到评论输入框"的原因）。
  已按实测名改写 `lib/act.mjs`，并保留旧选择器作回退。
- **评论框兜底**：展开面板后仍找不到输入框时，会把 `comment-list` 滚到底再找一次（输入区常是懒挂载）。
- **人设填目录**：以前只认目录里的 `AGENTS.md`，现在按 AGENTS.md → PERSONA.md → CLAUDE.md → README.md 取第一个存在的。
- **关键词分隔**：空格也算分隔（`"AI 萌宠"` 以前是一整条）。
- **端口复用前先做真往返**（`lib/cdp.mjs` 新增 `cdpHealthy`）：真机上撞见过一个**卡死的** Edge ——
  `/json/version` 正常答话，但 WebSocket 上的命令永远不回。旧逻辑据此判"活着"就复用，
  表现成「CDP Page.enable 超时 30s」，看着像"评论功能坏了"，其实是连到了僵尸。
- **明确端口不再被"挑端口"覆盖**（`lib/browser.mjs` `start()`）：以前传了 `port` 也会去扫 9333–9372，
  命中僵尸就复用；现在给了端口就只用它，被占且不响应会直接报「换个端口或先关掉它」。

# 1.4.0（2026-10-24，设置页照 dsh-bili-scroll 重做 + 评论人设）

按主人要求「据 dsh-bili-scroll 的界面，改 dsh-douyin-scroll，还有评论人设之类的」。

**版面**（一页一摊，不再是一条长龙）

- 顶上一排状态徽章：今天已挑 N/M 条 · 抖音登录态 · 浏览器模式 · 高峰/谷时 · 版本，
  右边是「现在跑一轮」。
- **日常 / 偏好 / 互动 / 高级** 四个标签页：登录与定时、刷什么与怎么判、对外发言与人设、
  运行参数与它的地盘。
- 开关、数字、下拉点了就存；**关键词 / 评论人设 / 博主链接这类文字先攒着**，
  点「保存改动」一起写（以前每敲一个字就 POST 一次，还会把别处正在改的值冲掉）。
- 上次被验证页中止过，顶上会挂红字说明，不再只是"今天没什么可看的"。

**新增配置 `personaPrompt`（评论人设）**

- 写草稿 / 评论 / 日报里「它自己的一句话」时按这个说话；填一段文字即可。
- **也可以填一个文件或目录路径**（如 `D:\x\AGENTS.md`）：是文件就现读那份、是目录就找
  `AGENTS.md`/`CLAUDE.md`/`PERSONA.md`/`README.md`；读不到就当没填（不拦这一轮、不报错到日志头部）。
- 人设只管"怎么说"，**不许因此编画面** —— 章程里的红线原样保留。

**顺手**

- 备用视觉模型（最多 2 条，`接口 | 模型 | 密钥`）和「测视觉接口」按钮挪到「偏好 · 怎么判」里。
- 「截帧留几天」「日报详略」也挪到「偏好 · 产出」。
- 高级里补「dsh 路径」和「日志详细程度」，并把家目录、config/duty/picks/seen/out/frames 列出来。

# 1.3.1（2026-10-24，P4 自查后）

1.3.0 交付后按「检查 P4」跑了一遍（真 mcp-server + outbox 单测），修两处：

- **「发送方式 = 自动发」以前要再开「评论并 @ 你」才生效**：整段评论逻辑挂在
  `if (cfg.autoComment)` 里，用户只把发送方式选成 auto、关着那个老开关 ⇒ 草稿永远
  发不出去，连日志都没有。现在 outbox 草稿走自己的分支，`autoComment` 只管老的
  「用 picks 的 reason 兜底评论」；配额用完时日志会说明还剩几条留在明天。
- **轮末不再无条件拉起浏览器**：review 模式只是排队，以前也会 `ensureDy()` ⇒ 每轮都
  把浏览器拉起来。现在按需懒启动（要收藏 / 要真发 / 要老兜底评论时才起）。

# 1.3.0（2026-10-24）

计划的 P3 / P4 两档。

**P3 视觉接口多待选位 + 自动降级**

- 新增配置 `visionBackups`（数组，最多 2 条），每行一条：`接口 | 模型 | 密钥`。
  候选顺序 = 主（`visionApiBase` / `visionApiKey` / `visionModel`）→ 备1 → 备2，
  **第一个成功的就用它**，`douyin_frames` 现在会带 `visionVia` 告诉你这轮用的是哪个。
- 全挂时报错不再是一句"失败了"，而是把每家的原因都列出来（`视觉接口全挂了：主(glm-4v)：HTTP 401…；备1(…)：超时`）。
- 新增 `GET /api/douyin-duty/test-vision` + 设置页「测视觉接口」：主 + 各备用各打一发，
  只验鉴权 / 模型名对不对（**不验看图能力**，那个要真图真钱）。
- `lib/vision.mjs` 的 `parseBackup()` / `candidates()` 可单独测（已单测：合法/非法行、主+备合并）。

**P4 评论 @ / 私聊 / 群 —— 默认全关，先入队，再按白名单 + 配额发**

- 新增 `lib/outbox.mjs`（待发件箱，`$DSH_HOME/douyin-duty/outbox.jsonl`）：
  `addDraft` / `listOutbox` / `setStatus` / `sentToday` / `quotaLeft` / `hitWhitelist`。
- **模型只有 `douyin_draft`（写草稿）和 `douyin_outbox`（看队列）两个新工具，没有任何"发送"工具** ——
  工具白名单仍然是安全边界，和收藏/评论这两只手一样。
- 新增配置（全部默认关 / 保守）：
  `outboxMode`（`review` 等你批准｜`auto` 过白名单+配额自动发，默认 review）、
  `commentAtEnabled`（真 @：打 `@名字` → 等下拉浮层 → 点第一个匹配项；弹不出来退回纯文本 @）、
  `dailyCommentQuota`（默认 5，按"真发出去的"算）、
  `dmEnabled` / `dmWhitelist` / `dmDailyQuota`、`groupEnabled` / `groupWhitelist` / `groupDailyQuota`。
- 私聊 / 群 **这一版只入队、不自动发送**：抖音私信页的 DOM 还没在真机上核对过，
  硬写一条没测过的点击链比不发更糟。批准后会被标成 `failed` 并写明原因，等实机核过再打开。
- 白名单为空 ⇒ 一个都不发（`hitWhitelist` 对空名单恒 false，`*` 才是全放行）。
- 新增接口：`GET /outbox`、`POST /outbox/approve`、`POST /outbox/discard`（后两个在 token 名单里；
  批准 = 立刻发，受每日配额限制，超了留 `pending` 等明天）。
- 设置页新增「对外发言」区：发送方式、真 @、评论日配额、私聊/群开关 + 白名单 + 日配额，
  以及待发件箱列表（每条可「批准并发出」/「丢弃」）。
- 顺带：`/status` 带出 `outbox`（待批条数 / 今日已发 / 配额 / 模式）；设置页顶栏能一眼看到。

**顺带清了三笔老账**（都是会真丢数据 / 真刷屏的那种）

- `runActions` 不再按"当天全量 picks"重做：新增动作账本 `acted.json`（按天记 id → 做过了什么），
  只处理**今天还没做过的**，一条视频一天最多收藏一次、评论一次。
  以前收藏是 toggle，第二轮会把第一轮收藏的**取消**掉；评论也会在同一条下面刷好几遍。
- `douyin_report` 默认改成 **追加**（分批写不再互相覆盖），要整篇重写显式传 `mode=overwrite`，
  且 overwrite 会先留一份 `.bak`；同一段重复写会被识别成 `dup` 不再追一遍。
- 单轮锁加 **30 分钟超时**：子进程卡死时不会再永久占着锁（以前只能重启客户端），
  超时会强制收掉并写 `lock-timeout.json` 记账。

已知限制（写清楚，别当没有）：

- 私聊 / 群不自动发送（见上）。
- 真 @ 依赖抖音评论下拉浮层的类名（`mention|suggest|listbox|option|at-list` 都试），
  改版就可能退化成纯文本 @，届时 `msg` 里会写明"@ 没弹下拉"。
- 动作账本按天记，跨天不做"这条视频以前收藏过"的判断（抖音侧本来就是收藏过的状态，重收藏是幂等的）。

# 1.2.0（2026-10-24）

对齐同类项目（NEWJO123/dsh-douyin-scroll、LockyBee/dsh-douyin-agent）后按用户计划做的三档改动：

**P0 浏览器不再抢前台 / 不再一开面板就起浏览器**

- 新增配置 `browserMode`：`auto`（先 hidden，起不来退 headless）/ `hidden`（真窗口挪到屏幕外 + 最小化）/ `headless` / `visible`；设置页「浏览器窗口」可切。
  抖音对 headless 的指纹更敏感，`hidden` 是真窗口、更像人，也不挡使用者干活。
- 端口复用（`cdp.mjs` 的 `pickPort`）：账本 `browser-runtime.json` 记着的端口先复用 → 扫 9333–9372 找已有 CDP → 都不行才找空口起新的。
  之前只挑空口 ⇒ 同一个 profile 起第二台浏览器会秒退，表现为"60 秒连不上 CDP"。
- `DOUYIN_BROWSER` 环境变量可指定浏览器；候选里加上 D:/E: 盘。
- **懒启动**：`/status` 只探活不再 `ensureDy()`（以前打开设置页就把浏览器拉起来）。登录才临时切 `visible`。

**P1 中途被验证/风控拦住 ⇒ 停下来写清楚，不假装正常**

- 新增 `lib/guard.mjs`：每步之前看一眼页面，命中「验证码 / 安全验证 / 滑块 / 访问频繁 / 操作过频 / 账号风险 / 网络请求异常 / 跳到 passport·verify·captcha」就中止。
- 中止时：截一张图（`frames/abort-<时间>.png`）+ 落 `abort-latest.json`（网址/标题/页面文字片段）+ 抛 `DouyinAbort`。
- 子进程（MCP）置 `ABORTED` 标记，之后刷视频类工具一律拒绝，只剩 `douyin_status` / `douyin_seen`。
- 宿主在子进程退出后识别中止：写进当天报告（「⚠️ 这一轮中途被中止 + 原因 + 停在哪 + 截图」），
  **并且不做收藏/评论**（不再继续拿用户账号冒险）；`state.lastAbort` 供面板显示红字提示条。
- 不自动点验证码（那是拿账号冒险）。

**P2 截帧不再无声长大**

- 新增配置 `retentionDays`（默认 7）：启动时清掉 `frames/` 里超过 N 天的 png。

顺带（此前已在运行目录）：

- 配置接口加本地 token + 字段白名单（`x-douyin-token`、Origin/Host/Sec-Fetch-Site 校验、未知字段回 `rejected`）。
- keywords / userUrls 支持 `/ , ， 、 ; ； 换行` 一起拆（面板里"一格写一串"不再被当一个词）。
- 视觉接口默认端点改智谱 `https://open.bigmodel.cn/api/paas/v4`（实测 200）。

**1.2.0 追加（2026-10-24 真机检查发现的两处）**

- 修：`douyin_status` 不返回 `keywords` ⇒ 值班那一轮只能看到章程里的**默认关键词组**，
  设置页填的「DeepSeek / 鲸鱼娘 / 大肥鱼同人」被静默跳过（当天实刷的是"编程/健身"）。
  现在 `douyin_status` 带出 `keywords` / `userUrls` / `mentionName` / 视觉配置状态，章程里也写明"先读它"。
- 修：视觉接口 `max_tokens: 500` 对 GLM-5.3-Flash 太小 —— 它先写一大段 `reasoning_content`，
  正文被挤空（实测 500 → content 空、reasoning 2005 字；3000 → 正常）。现在 3000 起步，
  正文空但有 reasoning 时自动加倍到 6000 再试，失败原因也写清（`finish=length`）。
# 1.1.0（2026-10-23）

对齐上游 dsh-bili-scroll 2.0.4 的平台无关修复：

- 修实机故障：`resolveDsh` 认识桌面版 DeepSeek Harness 自带的 dsh
  （直连 `DeepSeek Harness.exe --expose-internals .../dsh-desktop-host/lib/cli.js`，
  ELECTRON_RUN_AS_NODE、不经 cmd，避开 8191 字符参数上限；`dsh.cmd` 与 npm 全局作兜底；
  PATH 里解析绝对路径、绝不 shell:true 拼提示词 —— 对齐上游安全加固）。
  以前 `'dsh' 不是内部或外部命令`，每一轮 exit 1。
- 修实机故障：DSH 设置视图把 headlessProfile 递成对象 ⇒ `--profile [object Object]`。
  refreshCfg 现在只收原始值（string/number/boolean）。
- 单轮锁 + 子进程登记/清理（上游 2.0.4 体检第 2 条）：同一时间只允许一轮在跑，
  插件卸载时把正在跑的子进程一起收掉。
- `writeJson` 原子写（tmp + rename）：config.json / state.json 不再可能留半截。
- 值班章程升级改**记账制**（上游 M6）：`charter.sha256` 账本 —— 没改过自动升级，
  改过则新版落 `duty.md.new`，不再"一次铺定、永不更新"。

# 1.1.1（2026-10-23，实机验证后）

- MCP 服务脚本改用**桌面版自带真 node** 当解释器
  （`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`，v24）。
  以前写 `process.execPath`，在桌面版里那是 Electron 主程序，跑 .mjs 只在"父进程碰巧继承了
  ELECTRON_RUN_AS_NODE"时才成立；现在显式指定，并在退回主程序时把 ELECTRON_RUN_AS_NODE 写进 overlay env。
- 截帧 seek 不再偶发 `Promise was collected`：promise 挂 window 保活；
  真被回收也退化成"等一会儿直接截"，不丢整帧。
- `tools/mcp-probe.mjs` 的家目录不再写死作者机器路径（读 DOUYIN_HOME / DSH_HOME 兜底）。

# 1.1.2（2026-10-23，实机第二轮）

- 修实机故障：选中的 `dsh.cmd` 路径带空格（`…\DeepSeek Harness\…`），
  node 的 `spawn(shell:true)` **不会给 command 单独加引号**，整串塞进 `cmd /d /s /c "…"`
  后被砍成 `…\DeepSeek` ⇒ "'…\DeepSeek' 不是内部或外部命令"，exit 1。
  现在 shell 候选一律经 `shellCmd()` 补引号（已实测加引号后 `dsh.cmd --help` exit 0）。
- 修根因：直连 CLI 方案被 `existsSync` 误判。**cli.js 在 app.asar 归档内部**，
  普通 fs 的 existsSync 恒 false（只有 Electron 主进程打了 asar 补丁才查得到），
  于是 ② 被跳过、退回 ③。现在改为验证"主程序 + app.asar 归档"存在，
  cli.js 走 `noStatArgs` 免检 ⇒ 优先选 ②（无 cmd、无 8191 字符上限）。
  本机复现确认：选中「② 直连 CLI」，shell=false。
