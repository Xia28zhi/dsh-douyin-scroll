/**
 * lib/act.mjs —— **会动用户账号的两只手**：收藏 & 评论
 * ============================================================================
 * 🔴 安全设计（跟参考项目一致，甚至更严）：
 *   1. **模型碰不到这两只手** —— 一轮里模型只能调 `douyin_pick`（"我挑了这条"），
 *      真去收藏/发评论的是**宿主**，在一轮结束后按 `picks.json` + 开关执行；
 *   2. **默认全关**：收藏和评论都要使用者自己在设置页打开，评论还要填"要 @ 谁"；
 *   3. **dryRun 优先**：第一次建议开 dryRun（只写日志、不真动手）；
 *   4. **评论有每轮条数上限**，发完就停，绝不因为模型一句话连发十条。
 *
 * ⚠️ 实现方式：走**页面里的真实 UI 点击**，而不是伪造接口请求。
 *   抖音的写接口（评论/收藏）带签名和风控，裸 POST 大概率失败；
 *   而"在真浏览器里点一下"跟你自己点没有区别，稳得多。
 * ============================================================================
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在页面里找元素：按文本或属性，返回它的中心坐标（找不到返回 null） */
async function findBox(cdp, selector, text) {
  return cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const sel = ${JSON.stringify(selector)};
      const want = ${JSON.stringify(text || '')};
      const els = [...document.querySelectorAll(sel)];
      for (const e of els) {
        const label = (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim();
        if (want && !label.includes(want)) continue;
        let r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        // ⭐ 在视口外就先滚进来再算坐标（2026-10-24 真机：视频页的评论区在折叠线以下，
        //    按原始坐标点下去会点到视频/空白处，于是永远「没找到评论输入框」）
        if (r.top < 0 || r.bottom > (window.innerHeight || 0)) {
          try { e.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* 算了 */ }
          r = e.getBoundingClientRect()
        }
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: label.slice(0, 40) };
      }
      return null;
    })()`,
    returnByValue: true,
  }, 15_000).then((r) => r?.result?.value || null).catch(() => null)
}

async function clickAt(cdp, box) {
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, 10_000).catch(() => {})
  }
  return true
}

/**
 * 收尾：关掉自己开的那个标签。
 * ⚠️ 两条真机教训（2026-10-24，用户抱怨「Edge 开太多了」就是这两条造成的）：
 *   1. 关掉浏览器里**最后一个**标签会让整个浏览器退出 —— 之后还得重新拉起；
 *      所以只剩一个的时候不关，导航到 about:blank 就行；
 *   2. finally 里拿不到 try 里 `const { cdp }` 声明的变量（作用域），
 *      以前的写法在 finally 里抛 ReferenceError 被 catch 吞掉 ⇒ 标签从来没被关过、一直堆。
 *      所以调用方必须用外层声明的 `let cdp`，这里只负责关。
 */
async function closeTabQuietly(cdp, session, tab) {
  if (!tab) return
  try {
    const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, 8_000)
    if (targetInfos.length <= 1) {
      try { await cdp.send('Page.navigate', { url: 'about:blank' }, 8_000) } catch { /* 算了 */ }
      return
    }
  } catch { /* 拿不到目标列表就照常关 */ }
  try { await session.close(tab.target.id) } catch { /* 已经没了 */ }
}

/**
 * 按文字找一个**最小**的可见元素，返回中心坐标。
 * findBox 是按选择器 + 包含文字找的，容易命中外层大容器（点它的中心 ≠ 点那句话），
 * 评论条的占位文字「留下你的精彩评论吧」就踩过这个坑（2026-10-24 真机）。
 */
async function findSmallByText(cdp, text) {
  return cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const want = ${JSON.stringify(text)};
      let best = null;
      for (const e of document.querySelectorAll('div,span,p,button')) {
        const t = (e.textContent || '').trim();
        if (!t || !t.includes(want)) continue;
        let r = e.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) continue;
        if (r.width > innerWidth) continue;
        // ⭐ 在折叠线以下就先滚进来（评论区那行占位文字就在页面底部，以前直接被跳过）
        if (r.top < 0 || r.bottom > (window.innerHeight || 0)) {
          try { e.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* 算了 */ }
          r = e.getBoundingClientRect()
          if (r.width < 20 || r.height < 10) continue
        }
        const area = r.width * r.height;
        if (!best || area < best.area) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area, cls: (e.className || '').toString().slice(0, 40) };
      }
      return best;
    })()`,
    returnByValue: true,
  }, 15_000).then((r) => r?.result?.value || null).catch(() => null)
}

/**
 * 按**完全相等**的文字找元素并返回中心坐标（比「包含」稳）。
 * 真机教训（2026-10-24）：评论条那行占位文字「留下你的精彩评论吧」，
 * 用「包含」+ 最小面积会挑到内层小 span，点它的中心常常点不动；
 * 用完全相等拿到的正是那句占位文字本身，点下去 Draft 编辑器才真的激活。
 */
async function findExactBox(cdp, text) {
  return cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const want = ${JSON.stringify(text)};
      let best = null;
      for (const e of document.querySelectorAll('div,span,p,button,input')) {
        if ((e.textContent || '').trim() !== want) continue;
        let r = e.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) continue;
        if (r.top < 0 || r.bottom > (window.innerHeight || 0)) {
          try { e.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* 算了 */ }
          r = e.getBoundingClientRect()
        }
        const area = r.width * r.height;
        if (!best || area < best.area) best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area };
      }
      return best;
    })()`,
    returnByValue: true,
  }, 15_000).then((r) => r?.result?.value || null).catch(() => null)
}

async function findSendButton(cdp) {  return cdp.send('Runtime.evaluate', {
    expression: `(() => {
      // ⚠️ 必须**只**在评论条里找。页面上还有「弹幕」输入条，它也有一个文字为“发送”的按钮 ——
      //    2026-10-24 真机踩过：全页找“发送”点到了弹幕发送，评论根本没发出去。
      // 真机实测（probe13）：评论条右侧那一排图标依次是 图片/@/表情/发送，
      // 发送就是**最后一个带 svg 的 span**；点它之后评论框会清空。
      const cts = ['#comment-input-container .commentInput-right-ct', '.commentInput-right-ct', '#comment-input-container [class*="right-ct" i]', '[class*="commentInput-right" i]'];
      for (const sel of cts) {
        for (const ct of document.querySelectorAll(sel)) {
          const spans = [...ct.querySelectorAll('span')].filter((s) => s.querySelector('svg'));
          if (!spans.length) continue;
          const last = spans[spans.length - 1];
          const r = last.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), kind: 'last-icon' };
        }
      }
      // 退路：评论条里文字正好是“发送”的
      for (const b of document.querySelectorAll('#comment-input-container, [class*="comment-input" i]')) {
        for (const e of b.querySelectorAll('button,div,span,a')) {
          if ((e.textContent || '').trim() !== '发送') continue;
          const r = e.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), kind: 'text' };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  }, 15_000).then((r) => r?.result?.value || null).catch(() => null)
}

/**
 * 收藏一条视频
 * @returns {{ok:boolean, msg:string}}
 */
export async function fav(session, id, { dryRun = true } = {}) {
  if (dryRun) return { ok: true, msg: 'dryRun：没真收藏' }
  let tab = null
  let cdp = null
  try {
    tab = await session.tab(`https://www.douyin.com/video/${encodeURIComponent(String(id))}`)
    cdp = tab.cdp
    await cdp.send('Page.enable')
    await sleep(4_000)
    // 2026-10 真机实测（登录态、无头 CDP 打到 live 页面）：
    //   收藏 = [data-e2e="video-player-collect"]、赞 = video-player-digg、评论入口 = feed-comment-icon
    //   ⚠️ 这些页面上 aria-label 全是空的 —— 以前靠 aria/class 猜，必然找不到
    const box = await findBox(cdp, '[data-e2e="video-player-collect"],[class*="collect"],[aria-label*="收藏"],[class*="favorite"]', '收藏')
    if (!box) return { ok: false, msg: '页面上没找到收藏按钮（抖音改版了？）' }
    await clickAt(cdp, box)
    await sleep(1_200)
    const after = await findBox(cdp, '[data-e2e="video-player-collect"],[class*="collect"],[aria-label*="收藏"]', '已收藏')
    return { ok: true, msg: after ? '已收藏' : '点了一下收藏（没二次确认到状态）' }
  } catch (e) {
    return { ok: false, msg: String(e?.message ?? e).slice(0, 160) }
  } finally {
    if (tab) { try { await closeTabQuietly(cdp, session, tab) } catch { /* 关不掉就算了 */ } }
  }
}

/**
 * 在一条视频下**发一条评论**
 * ---------------------------------------------------------------
 * `mention`（P4）：给了就走「真 @」—— 先在输入框打 `@名字`，等好友下拉出来，
 *   点中那个好友（编辑器里会变成 `douyin_mention_word` 词条，能通知到人），再输入正文。
 *   下拉没出来 / 没这个好友 ⇒ 退回纯文本 `@名字 `，并把 mention 记成 'plain'、在 msg 里说明。
 * @returns {{ok:boolean, msg:string, mention:'real'|'plain'|''}}
 */
export async function comment(session, id, text, { dryRun = true, mention = '' } = {}) {
  const who = String(mention || '').trim().replace(/^@+/, '')
  const body = String(text || '').trim()
  if (dryRun) return { ok: true, msg: 'dryRun：没真发，内容是「' + body.slice(0, 40) + '」', mention: who ? 'plain' : '' }
  if (!body) return { ok: false, msg: '评论是空的', mention: '' }
  let tab = null
  let cdp = null
  try {
    tab = await session.tab(`https://www.douyin.com/video/${encodeURIComponent(String(id))}`)
    cdp = tab.cdp
    await cdp.send('Page.enable')
    await sleep(4_000)

    // ① 找评论输入框。
    //   2026-10-24 真机实测（主人截图 + 无头 CDP 打到 live 页面）：这一版评论区是 **Draft.js**
    //   —— 真正的输入框是 `.public-DraftEditor-content[contenteditable="true"]`，
    //   **而且没点开之前页面上根本没有 contenteditable**，只有一句占位文字「留下你的精彩评论吧」。
    //   以前直接 querySelector('[contenteditable="true"]') 必然找不到 ⇒ 6 条评论全报「没找到评论输入框」。
    //   正确顺序：点评论入口展开面板 → **点占位文字把编辑器激活** → 才找得到编辑器。
    //   ⚠️ 占位文字在**没激活时**不含 richtext-container / DraftEditorPlaceholder 这些类名
    //   （真机里是 `<div class="RXtfhfhu">留下你的精彩评论吧</div>`），所以必须按文字找最小元素点，
    //   否则会点到大容器的中心，等于没点。
    const inputSel = '#comment-input-container .public-DraftEditor-content[contenteditable="true"],#comment-input-container [contenteditable="true"],.comment-input-inner-container .public-DraftEditor-content[contenteditable="true"],.comment-input-inner-container [contenteditable="true"],[class*="comment-input" i] [contenteditable="true"],[class*="commentInput" i] [contenteditable="true"],.public-DraftEditor-content[contenteditable="true"],[contenteditable="true"],textarea'
    const openerSel = '[data-e2e="feed-comment-icon"],[data-e2e="comment-icon"],[data-e2e="comment-list"],[aria-label*="评论"]'
    let box = null
    for (let attempt = 0; attempt < 3 && !box; attempt++) {
      if (attempt) await sleep(1_800)
      box = await findBox(cdp, inputSel, '')
      if (box) break
      // 展开评论面板：先按已知入口点，退一步点「全部评论」标题那一行
      const opener = await findBox(cdp, openerSel, '')
      if (opener) {
        await clickAt(cdp, opener)
        await sleep(1_500)
      } else {
        const head = await findSmallByText(cdp, '全部评论')
        if (head) {
          await clickAt(cdp, head)
          await sleep(1_200)
        }
      }
      // 点「留下你的精彩评论吧」这句话本身（取最小的那个元素）
      const ph = (await findExactBox(cdp, '留下你的精彩评论吧')) || (await findSmallByText(cdp, '留下你的精彩评论'))
      if (ph) {
        await clickAt(cdp, ph)
        await sleep(1_200)
      }
      box = await findBox(cdp, inputSel, '')
      if (!box) {
        // 再滚到页面底部，评论区有时是懒加载
        await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const l = document.querySelector('[data-e2e="comment-list"]');
            if (l) l.scrollTop = l.scrollHeight;
            window.scrollTo(0, document.body.scrollHeight);
            return 'scrolled';
          })()`,
          returnByValue: true,
        }, 8_000).catch(() => {})
        await sleep(1_200)
      }
    }
    // ⭐ 最后一搏（2026-10-24 真机：有个别视频页重试三轮都报「没找到输入框」，
    //    单独诊断发现「点占位文字 → contenteditable 确实出现了」，只是比以前慢）。
    //    所以这里放宽节奏再试一次：滚到底 → 点占位文字 → 等 2.5 秒 → 再找。
    if (!box) {
      await cdp.send('Runtime.evaluate', {
        expression: `window.scrollTo(0, document.body.scrollHeight);'ok'`,
        returnByValue: true,
      }, 8_000).catch(() => {})
      await sleep(800)
      const ph = (await findExactBox(cdp, '留下你的精彩评论吧')) || (await findSmallByText(cdp, '留下你的精彩评论'))
      if (ph) {
        await clickAt(cdp, ph)
        await sleep(2_500)
      }
      box = await findBox(cdp, inputSel, '')
    }
    if (!box) return { ok: false, msg: '没找到评论输入框（评论面板没展开 / 掉登录 / 页面改版）', mention: '' }
    // 输入框可能被滚到视口外 —— 先滚进来再点（真机里评论区常常在折叠线以下，点坐标会点到别处）
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const ed = document.querySelector('#comment-input-container, .comment-input-inner-container, [class*="comment-input" i], [class*="commentInput" i]');
        if (ed && ed.scrollIntoView) ed.scrollIntoView({ block: 'center', inline: 'nearest' });
        return 'ok';
      })()`,
      returnByValue: true,
    }, 8_000).catch(() => {})
    await sleep(600)
    box = (await findBox(cdp, inputSel, '')) || box
    await clickAt(cdp, box)
    await sleep(400)
    // 清掉可能残留的草稿（Draft.js 会把上次没发出去的内容留着）
    // ⚠️ 只清**评论框**，别把弹幕框里的东西清掉。
    // ⚠️ 别用 execCommand：真机实测（2026-10-24）它会让 Draft.js 的编辑器重建，
    //    之后的按键全部落空（编辑器里是空的，@ 下拉却还弹着），评论就变成没内容的空发。
    //    改成键盘操作：Ctrl+A → Backspace，并且只在真有内容时才清。
    const left = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const ed = document.querySelector('#comment-input-container .public-DraftEditor-content[contenteditable="true"], .comment-input-inner-container .public-DraftEditor-content[contenteditable="true"]');
        return ed ? (ed.innerText || '').trim().length : -1;
      })()`,
      returnByValue: true,
    }, 8_000).then((r) => Number(r?.result?.value)).catch(() => -1)
    if (left > 0) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' }, 10_000).catch(() => {})
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' }, 10_000).catch(() => {})
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace', nativeVirtualKeyCode: 8 }, 10_000).catch(() => {})
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace', nativeVirtualKeyCode: 8 }, 10_000).catch(() => {})
      await sleep(300)
    }
    // 确认焦点确实落在**评论框**里（否则一会打的字会跑到别处去）
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const ed = document.querySelector('#comment-input-container .public-DraftEditor-content[contenteditable="true"], .comment-input-inner-container .public-DraftEditor-content[contenteditable="true"]');
        if (ed && document.activeElement !== ed) ed.focus();
        return ed ? (document.activeElement === ed ? 'focused' : 'not-focused') : 'no-editor';
      })()`,
      returnByValue: true,
    }, 8_000).catch(() => {})

    // ② 真 @（可选）：打 `@名字` → 等好友下拉 → 点中那个人
    //   2026-10-24 真机实测（无头 CDP 打到 live 页面，见 .probe-at/probe10）：
    //   下拉的容器是 `.atBox-inner-container`，每个好友名字在 `span.lgAE_oZa`。
    //   点中之后编辑器里那一截会变成 `<span class="douyin_mention_word">@名字</span>` —— 这才是抖音认的真 @。
    //   ⚠️ 以前拿 `[class*="mention" i]` / `[role="listbox"] li` 去找，一个都匹配不上 ⇒ 永远退回纯文本 @。
    let how = ''
    if (who) {
      const typed = '@' + who
      // 先逐字敲 —— 真机里逐字敲比一次性 insertText 更容易把 @ 下拉叫出来（Draft.js 要看到输入事件）
      const typeChars = async (str) => {
        for (const ch of str) {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch }, 10_000).catch(() => {})
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, 10_000).catch(() => {})
          await sleep(220)
        }
      }
      const clearTyped = async (n) => {
        for (let i = 0; i < n; i++) {
          await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace', nativeVirtualKeyCode: 8 }, 10_000).catch(() => {})
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace', nativeVirtualKeyCode: 8 }, 10_000).catch(() => {})
        }
        await sleep(300)
      }
      const pickOne = () => cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const want = ${JSON.stringify(who)};
          const box = document.querySelector('.atBox-inner-container');
          if (!box) return null;
          const items = [...box.querySelectorAll('span.lgAE_oZa')].filter((e) => (e.textContent || '').trim());
          if (!items.length) return null;
          const pick = (f) => items.find(f);
          const el = pick((e) => e.textContent.trim() === want)
            || pick((e) => e.textContent.trim().startsWith(want))
            || pick((e) => e.textContent.trim().includes(want))
            || (items.length === 1 ? items[0] : null);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: el.textContent.trim().slice(0, 40) };
        })()`,
        returnByValue: true,
      }, 15_000).then((r) => r?.result?.value || null).catch(() => null)

      await typeChars(typed)
      await sleep(1_600)
      let opt = await pickOne()
      if (!opt) {
        // 没弹下拉：删掉重来一次（第二遍慢一点，给前端筛选留时间）
        await clearTyped(typed.length)
        await typeChars(typed)
        await sleep(2_400)
        opt = await pickOne()
      }
      if (opt) {
        await clickAt(cdp, opt)
        await sleep(700)
        // 点中没点中，看编辑器里有没有 mention 词条 —— 不猜
        const isReal = await cdp.send('Runtime.evaluate', {
          expression: `!!document.querySelector('.public-DraftEditor-content .douyin_mention_word')`,
          returnByValue: true,
        }, 10_000).then((r) => Boolean(r?.result?.value)).catch(() => false)
        how = isReal ? 'real' : 'plain'
      } else {
        how = 'plain'
      }
      if (how === 'plain') {
        // 退成纯文本：把刚打的 `@名字` 退格删掉，再打一遍「@名字 正文」，别让正文粘在 @ 后面
        await clearTyped(typed.length)
        await cdp.send('Input.insertText', { text: typed + ' ' + body }, 10_000).catch(() => {})
      } else {
        await cdp.send('Input.insertText', { text: ' ' + body }, 10_000).catch(() => {})
      }
    } else {
      await cdp.send('Input.insertText', { text: body }, 10_000).catch(async () => {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: body }, 10_000).catch(() => {})
      })
    }
    await sleep(800)

    // ③ 点“发送”。
    //   2026-10-24 真机实测：这一版**没有**文字是「发送」的按钮，发送是评论条右侧那个**红箭头图标**
    //   （`<span><svg><path fill="#FE2C55" …>`）。以前按文字找「发送」必然找不到 ⇒ 评论写进去了却没发出去。
    const send = await findSendButton(cdp)
    if (!send) return { ok: false, msg: '没找到发送按钮（评论可能没写进去）', mention: how }
    await clickAt(cdp, send)
    await sleep(2_000)

    // ④ 复核一下有没有真的出现（接口回成功 ≠ 公开可见，老号也可能进审核）
    const appeared = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const t = ${JSON.stringify(body.slice(0, 30))};
        return document.body.innerText.includes(t);
      })()`,
      returnByValue: true,
    }, 10_000).then((r) => Boolean(r?.result?.value)).catch(() => false)
    const atNote = how === 'plain' && who ? '（@ 没弹下拉，退成纯文本 @，可能通知不到人）' : ''
    return {
      ok: true,
      msg: (appeared ? '已发出（页面上看到了）' : '点了发送，但页面上没看到（可能在审核，别重复发）') + atNote,
      mention: how,
    }
  } catch (e) {
    return { ok: false, msg: String(e?.message ?? e).slice(0, 160), mention: '' }
  } finally {
    if (tab) { try { await closeTabQuietly(cdp, session, tab) } catch { /* 关不掉就算了 */ } }
  }
}

/**
 * 把一条视频**分享**给某个好友 / 群里（= 在视频页点「分享」→ 那一行点「分享」按钮）。
 * ---------------------------------------------------------------------------
 * 2026-10-24 真机实测（无头/有头 CDP 打到 live 页面）：
 *   - 「分享」图标不是点出来的，是**鼠标移上去**就弹面板（点反而什么都不发生）；
 *     图标位置 = 点赞/评论/收藏/分享那一行里**第 4 个**数字左边那个 42×42 的 svg；
 *   - 面板容器 class 是 `VzoNDwLw`，标题「分享给朋友」，每一行 = 头像 + 名字 + 状态 + 一个「分享」按钮
 *     （按钮在 x≈620 那一列）；点那个按钮就把视频卡片发进这个人的私信；
 *   - 面板里**没有「群」**这一栏（至少这个号没有），所以 kind='group' 只能按名字在同一个列表里找，
 *     找不到就如实失败，绝不瞎点。
 */
export async function share(session, videoId, to, { dryRun = false } = {}) {
  const who = String(to || '').trim()
  if (!who) return { ok: false, msg: '没给要分享给谁（好友名/群名）' }
  let tab = null
  let cdp = null
  try {
    tab = await session.tab(`https://www.douyin.com/video/${videoId}`)
    cdp = tab.cdp
    await cdp.send('Page.enable').catch(() => {})
    await sleep(4_500)

    // ① 找「分享」图标（第 4 个计数左边那个 svg），鼠标移上去把面板召出来
    const icon = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const nums = [...document.querySelectorAll('span,div')].filter((e) =>
          !e.children.length && /^\\d{1,6}$/.test((e.textContent || '').trim()) && e.getBoundingClientRect().y > 300);
        const byY = new Map();
        for (const e of nums) { const r = e.getBoundingClientRect(); const k = Math.round(r.y / 10); if (!byY.has(k)) byY.set(k, []); byY.get(k).push(e); }
        for (const [, arr] of byY) {
          if (arr.length !== 4) continue;
          const sv = arr[3].parentElement?.querySelector('svg');
          if (!sv) continue;
          const r = sv.getBoundingClientRect();
          if (r.width < 10) continue;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
      })()`,
      returnByValue: true,
    }, 15_000).then((r) => r?.result?.value || null).catch(() => null)
    if (!icon) return { ok: false, msg: '没找到「分享」图标（页面结构变了 / 没登录）' }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: icon.x, y: icon.y }).catch(() => {})

    // ② 等面板出来（最多 8 秒）
    let rows = []
    // 行与名字的配对：**按同一水平线**配 —— 每个「分享」按钮，取与它 y 对齐、在它左边的短文本当名字。
    // （2026-10-24 真机：按「往上数 N 层祖先」取 innerText 会数到列表容器 / 别的行，
    //   出来一堆「星全、莉莉玛莲」这种根本不是这一行的人；按 y 对齐一次就对上了）
    const scanRows = () => cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const btns = [];
        for (const b of document.querySelectorAll('button,div,span')) {
          if ((b.textContent || '').trim() !== '分享') continue;
          const r = b.getBoundingClientRect();
          if (r.width < 20 || r.height < 12 || r.y < 250 || r.x < 420) continue;
          btns.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
        const texts = [];
        for (const e of document.querySelectorAll('div,span,p')) {
          if (e.children.length) continue;
          const t = (e.textContent || '').trim();
          if (!t || t.length > 16) continue;
          const r = e.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          texts.push({ t, x: Math.round(r.x), y: Math.round(r.y + r.height / 2) });
        }
        const seen = new Set();
        const out = [];
        for (const b of btns) {
          const near = texts.filter((o) => Math.abs(o.y - b.y) <= 16 && o.x < b.x - 40 && o.x > b.x - 400)
            .sort((p, q) => Math.abs(p.y - b.y) - Math.abs(q.y - b.y) || q.x - p.x);
          const name = (near[0]?.t || '').trim();
          if (!name || name === '回复') continue;
          const key = name + '|' + b.y;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ name, row: name, btn: b });
        }
        return out;
      })()`,
      returnByValue: true,
    }, 15_000).then((r) => r?.result?.value || []).catch(() => [])

    for (let i = 0; i < 16 && !rows.length; i++) {
      await sleep(500)
      rows = await scanRows()
    }
    if (!rows.length) return { ok: false, msg: '「分享」面板没弹出来' }

    // ③ 先在**已经弹出来的列表**里按名字找（面板默认那几位好友就在第一屏）
    const byName = () => rows.find((r) => r.name === who) || rows.find((r) => r.row.includes(who))
    let hit = byName()

    // ③.5 没找到再用顶部搜索框。⚠️ 真机实测：这个搜索框搜的是**好友**，
    //      面板里第一屏能看到的人（比如备注过的）不一定在好友库的搜索结果里 ——
    //      所以搜完「没有搜索到朋友」不代表没有，列表本身仍然可以点。
    if (!hit) {
      const searchBox = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          for (const e of document.querySelectorAll('input')) {
            const r = e.getBoundingClientRect();
            if (r.width < 80 || r.height < 16 || r.y < 150) continue;
            if (!/搜索/.test(e.placeholder || '')) continue;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
          return null;
        })()`,
        returnByValue: true,
      }, 15_000).then((r) => r?.result?.value || null).catch(() => null)
      if (searchBox) {
        await clickAt(cdp, searchBox)
        await sleep(300)
        await cdp.send('Input.insertText', { text: who }, 10_000).catch(() => {})
        await sleep(1_800)
        const filtered = await scanRows()
        const best = filtered.find((r) => r.name === who) || filtered.find((r) => r.row.includes(who))
        if (best) { hit = best; rows = filtered }
      }
    }

    // ④ 找到就点它那一行的「分享」
    if (!hit) {
      return {
        ok: false,
        msg: `面板里没有「${who}」（可分享的 ${rows.length} 个：${rows.map((r) => r.name).slice(0, 8).join('、')}）`,
        canShare: rows.map((r) => r.name).slice(0, 20),
      }
    }
    if (dryRun) return { ok: true, msg: `[演练] 会在「${who}」那一行点「分享」` }

    await clickAt(cdp, hit.btn)
    await sleep(2_200)

    // ④ 复核：面板里那一行通常会变成「已分享」，或者页面弹「分享成功」
    const done = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const t = document.body.innerText;
        if (/分享成功|已分享|已发送/.test(t)) return true;
        return false;
      })()`,
      returnByValue: true,
    }, 10_000).then((r) => Boolean(r?.result?.value)).catch(() => false)
    return { ok: true, msg: done ? `已分享给「${who}」（页面确认）` : `点了「${who}」的分享按钮（页面没回确认，去私信里看看）` }
  } catch (e) {
    return { ok: false, msg: String(e?.message ?? e).slice(0, 160) }
  } finally {
    if (tab) { try { await closeTabQuietly(cdp, session, tab) } catch { /* 关不掉就算了 */ } }
  }
}
