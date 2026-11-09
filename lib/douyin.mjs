/**
 * lib/douyin.mjs —— 抖音网页版私信/群聊：打开会话、发文字、回读。
 *
 * 全部基于我们自己的 CDP 客户端（lib/cdp.mjs），不依赖任何第三方插件代码。
 * 已知结构（2026-11-09 探测）：
 *   · 会话行：class 里带 conversationConversationItemtitleWrapper
 *   · 输入框：div[contenteditable=true] class 带 editor-kit-container messageEditorinputArea
 *   · 发送：编辑器里按 Enter（页面上没有独立"发送"按钮）
 */
import { humanType, humanPauseBeforeClick, humanPauseAfterClick } from './human.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 打开私信页（调用前先注入 cookie）——等会话列表真的渲染出来再返回 */
export async function openChat(browser) {
  await browser.goto('https://www.douyin.com/chat', 6000)
  for (let i = 0; i < 20; i++) {
    const ready = await browser.eval(`Boolean(document.querySelector('[class*="conversationConversationItem"]'))`)
    if (ready) return true
    await sleep(700)
  }
  return false
}

/** 按昵称/群名打开会话；返回 {ok, x, y} */
export async function openConversation(browser, name) {
  const hit = await browser.eval(`(() => {
    const want = ${JSON.stringify(String(name))}
    const norm = (s) => (s || '').replace(/\\s*\\(\\d+\\)\\s*$/, '').trim()
    const els = [...document.querySelectorAll('[class*="conversationConversationItem"]')]
    for (const el of els) {
      const t = norm(el.innerText || el.textContent)
      if (t && (t === want || t.split('\\n')[0].trim() === want)) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          el.scrollIntoView({ block: 'center' })
          const rr = el.getBoundingClientRect()
          return { ok: true, x: rr.x + rr.width / 2, y: rr.y + Math.min(28, rr.height / 2), w: rr.width, h: rr.height, text: t.slice(0, 40) }
        }
      }
    }
    const all = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && norm(e.textContent) === want)
    if (all.length) {
      const r = all[0].getBoundingClientRect()
      if (r.width > 0) return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: want }
    }
    return { ok: false, names: els.slice(0, 10).map((e) => norm(e.innerText || e.textContent).slice(0, 24)) }
  })()`)
  if (!hit?.ok) return hit || { ok: false }

  const editorReady = () => browser.eval(`Boolean([...document.querySelectorAll('div[contenteditable="true"]')].find((e) => /messageEditor/.test(e.className || '')))`)
  // 点一下没打开就换个落点再试（列表项里有的区域点上去不响应）
  const spots = [
    { x: hit.x, y: hit.y },
    { x: hit.x, y: hit.y + 12 },
    { x: hit.x - 40, y: hit.y },
  ]
  for (const s of spots) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x: s.x, y: s.y, button: 'left', clickCount: 1 })
    }
    await sleep(1200)
    if (await editorReady()) return hit
  }
  return { ...hit, opened: false }
}

/** 找输入框的坐标 */
export async function editorBox(browser) {
  return browser.eval(`(() => {
    const ed = [...document.querySelectorAll('div[contenteditable="true"]')]
      .find((e) => /messageEditor|editor-kit-container/.test(e.className || ''))
    if (!ed) return null
    const r = ed.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
}

/** 输入一段文字（不发送；click=false 时不再点输入框，避免光标跳走） */
export async function typeText(browser, text, { click = true } = {}) {
  if (click) {
    const box = await editorBox(browser)
    if (!box) throw new Error('找不到输入框')
    await humanPauseBeforeClick()
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
    await humanPauseAfterClick()
  }
  // 逐字输入：像人在打字，而不是一次性粘贴
  await humanType(browser, text)
  await sleep(400)
  return true
}

/** 按 Enter 发送 */
export async function pressEnter(browser) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await browser.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(800)
}

/**
 * 在输入框里打一个 @ 并选中某人。
 * 抖音只认「真实点选」——所以这里必须走真实键盘打出 @，再真实鼠标点弹层那一行。
 * 返回 {ok, name}；失败时给出弹层里看到的前几个人名，方便排查。
 */
export async function mention(browser, name) {
  const want = String(name || '').trim()
  if (!want) return { ok: false, error: '缺要 @ 的人名' }
  const box = await editorBox(browser)
  if (!box) return { ok: false, error: '找不到输入框' }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await sleep(300)
  // Shift+2 打出 @
  const keys = { key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, modifiers: 8 }
  await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keys })
  await browser.send('Input.dispatchKeyEvent', { type: 'char', text: '@', unmodifiedText: '@', ...keys })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keys })
  await sleep(1200)

  // ⭐ 弹层只列前几个人：先打名字前 1~3 个字做过滤，否则永远“没有这个人”
  const probe = String(want).replace(/[（(].*$/, '').trim().slice(0, 3)
  if (probe) {
    await browser.send('Input.insertText', { text: probe })
    await sleep(900)
  }

  const hit = await browser.eval(`(() => {
    const want = ${JSON.stringify(want)}
    const box = document.querySelector('[class*="MsgInputMentionmentionContainer"]')
    if (!box) return { ok: false, error: '弹层没出来' }
    const rows = [...box.children].filter((e) => (e.innerText || '').trim()).slice(0, 30)
    const nameOf = (e) => (e.innerText || '').replace(/\\s+/g, ' ').replace(/^(群主|管理员|副群主)\\s*/, '').trim()
    const names = rows.map(nameOf).slice(0, 30)
    let cand = rows.find((e) => nameOf(e) === want)
    if (!cand) cand = rows.find((e) => nameOf(e).includes(want) || want.includes(nameOf(e)))
    if (!cand) {
      const head = String(want).slice(0, 2)
      cand = rows.find((e) => nameOf(e).includes(head))
    }
    if (!cand) return { ok: false, error: '弹层里没有这个人', names }
    cand.scrollIntoView({ inline: 'center', block: 'nearest' })
    const r = cand.getBoundingClientRect()
    return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, picked: nameOf(cand) }
  })()`)
  if (!hit?.ok) return hit
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
  }
  await sleep(500)
  // 🔴 点完弹层焦点跑到弹层上，后面的字会插到 @ 前面 —— 点回输入框、光标移到末尾
  const again = await editorBox(browser)
  if (again) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x: again.x + Math.min(120, again.w / 2 - 10), y: again.y, button: 'left', clickCount: 1 })
    }
    await sleep(200)
    await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
    await sleep(200)
  }
  // 🔴 校验：弹层点完，输入框里得真的出现「@名字」，否则后面的字会直接粘成一个怪句子
  const editorText = await browser.eval(`(() => {
    const ed = [...document.querySelectorAll('div[contenteditable="true"]')].find((e) => /messageEditor/.test(e.className || ''))
    return ed ? (ed.innerText || '').trim() : ''
  })()`)
  const wantName = String(hit.picked || name).trim()
  if (editorText && !editorText.includes(wantName)) {
    return { ok: false, error: `点了弹层但输入框里没出现「@${wantName}」`, editorText: editorText.slice(0, 40), picked: hit.picked }
  }
  return { ok: true, picked: hit.picked }
}

/** 把消息列表滚到底（React 虚拟列表会重置 scrollTop，必须用真实滚轮事件） */
export async function scrollToBottom(browser) {
  const pt = await browser.eval(`(() => {
    const z = document.querySelector('[class*="messageMessageListlist"]')
    if (!z) return null
    const r = z.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(z.scrollTop), max: z.scrollHeight - z.clientHeight }
  })()`)
  if (!pt) return false
  for (let i = 0; i < 30; i++) {
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: 600 })
    await sleep(160)
    const st = await browser.eval(`(() => { const z = document.querySelector('[class*="messageMessageListlist"]'); return z ? { top: Math.round(z.scrollTop), max: z.scrollHeight - z.clientHeight } : null })()`)
    if (st && st.max > 0 && st.top >= st.max - 30) break
  }
  await sleep(700)
  return true
}

/**
 * 读当前会话最近几条消息（按时间正序返回）。
 * 🔴 2026-11-09 关键发现：消息列表是**新的在最上面**（DOM 顺序 = 倒序），
 *    所以取前 N 行再反转，别去读最后几行（那是最旧的，之前一直读错就是栽在这）。
 */
export async function readRecent(browser, n = 6, { scroll = false } = {}) {
  if (scroll) await scrollToBottom(browser)
  const list = await browser.eval(`(() => {
    const zone = document.querySelector('[class*="messageMessageListlist"]') || document.querySelector('[class*="messageMessageListwrapper"]')
    if (!zone) return []
    const rows = [...zone.querySelectorAll('[class*="messageMessageBoxmessageBox"]')]
    const out = []
    for (const r of rows) {
      const textEl = r.querySelector('[class*="TextMessageTexttextInnerContent"], [class*="TextMessageTextpureText"], [class*="bubbleTextContent"]')
      const whoEl = r.querySelector('[class*="MessageBoxMessageTitleavatarName"], [class*="avatarName"]')
      const text = ((textEl && textEl.innerText) || '').trim()

      // 没有文字但有一张大图 => 表情包/图片消息
      const bigImg = [...r.querySelectorAll('img')].find((e) => {
        const w = e.getBoundingClientRect().width
        const cls = String(e.className || '')
        return w >= 60 && !/avatar|Avatar|commonStreak|commonConversationIcon|icon/i.test(cls)
      })

      if (!text) {
        if (!bigImg) continue
        const whoImg = ((whoEl && whoEl.innerText) || '').trim().slice(0, 24)
        out.push({ who: whoImg || '__peer__', text: '[图片]', image: String(bigImg.getAttribute('src') || '') })
        if (out.length >= ${Number(n)}) break
        continue
      }
      // 私信里常常没有昵称节点：用 isFromMe 判断是我发的还是对方发的
      // 按气泡位置判断「谁发的」：自己发的靠右、对方靠左（类名抖得太厉害，位置最稳）
      let selfByClass = false
      try {
        const rowR = r.getBoundingClientRect()
        const target = textEl || r
        const tr = target.getBoundingClientRect()
        const textCenter = tr.x + tr.width / 2
        const rowCenter = rowR.x + rowR.width / 2
        selfByClass = textCenter > rowCenter + 20
      } catch { selfByClass = false }

      let who = ((whoEl && whoEl.innerText) || '').trim().slice(0, 24)
      if (!who) who = selfByClass ? '__self__' : '__peer__'
      out.push({ who, text: text.slice(0, 160) })
      if (out.length >= ${Number(n)}) break
    }
    return out
  })()`)
  const arr = Array.isArray(list) ? list : []
  return arr.reverse()   // 反转成时间正序（最后一条 = 最新）
}

/** 会话列表里那行的预览（最可靠的"发出去没有"凭据：发完会变成「刚刚 · <内容>」） */export async function readListPreview(browser, name) {
  const want = String(name || '').trim()
  return browser.eval(`(() => {
    const want = ${JSON.stringify(want)}
    const norm = (s) => (s || '').replace(/\\s*\\(\\d+\\)\\s*$/, '').trim()
    const rows = [...document.querySelectorAll('[class*="conversationConversationItem"]')]
    for (const r of rows) {
      const t = (r.innerText || '').replace(/\\n+/g, ' | ')
      if (t.split('|')[0].trim() === norm(want)) return t.slice(0, 120)
    }
    return ''
  })()`)
}

/** 一步到位：打开会话 →（可选 @）→ 输入 → 发送 → 回读 */
export async function sendMessage(browser, { to, text, dry = false, at = '' }) {
  await openChat(browser)
  const conv = await openConversation(browser, to)
  if (!conv?.ok) return { ok: false, error: `找不到会话「${to}」`, seen: conv?.names || [] }
  let atInfo = null
  if (at) {
    atInfo = await mention(browser, at)
    if (!atInfo.ok) return { ok: false, error: `@${at} 没成功：${atInfo.error}`, names: atInfo.names || [] }
    await typeText(browser, text, { click: false })
  } else {
    await typeText(browser, text)
  }
  if (dry) {
    await browser.eval(`(() => { const ed = [...document.querySelectorAll('div[contenteditable="true"]')].find(e=>/messageEditor/.test(e.className||'')); if (ed) { ed.focus(); document.execCommand('selectAll'); document.execCommand('delete') } return true })()`)
    return { ok: true, dry: true, to, typed: text, at: atInfo?.picked || '', conversation: conv.text }
  }
  const how = await clickSend(browser)
  await sleep(1200)
  // ⭐ 回读分两路：页面消息区（可能虚拟化/滞后）+ 会话列表预览（最稳）
  const tail = await readRecent(browser, 5)
  let preview = ''
  try {
    await openChat(browser)
    preview = await readListPreview(browser, to)
  } catch { /* 预览拿不到不算失败 */ }
  const head = text.slice(0, Math.min(12, text.length))
  const appeared = tail.some((m) => String(m.text || '').includes(head)) || preview.includes(head)
  return { ok: true, to, sent: true, at: atInfo?.picked || '', appeared, preview, tail }
}

/**
 * 发表情包（抖音自带的那套：续火花/比心/在干嘛/笑死…）。
 * 流程：开表情面板 → 按关键词找（找不到就随机）→ 真鼠标点 → 若进了输入框再按 Enter。
 */
export async function sendSticker(browser, { to, keyword = '' }) {
  await openChat(browser)
  let conv = await openConversation(browser, to)
  for (let i = 0; i < 3 && !conv?.ok; i++) {
    await sleep(1500)
    await openChat(browser)
    conv = await openConversation(browser, to)
  }
  if (!conv?.ok) return { ok: false, error: `找不到会话「${to}」`, seen: conv?.names || [] }
  const btn = await browser.eval(`(() => { const el = document.querySelector('svg.messageMsgInputiconAction'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  if (!btn) return { ok: false, error: '找不到表情按钮' }
  for (const type of ['mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  const hit = await browser.eval(`(() => {
    const kw = ${JSON.stringify(String(keyword || ''))}
    const items = [...document.querySelectorAll('[class*="emojiEmojiItememojiItem"]')]
      .filter((e) => !/imgBox|Desc/.test(e.className || ''))
    const list = items.map((e) => ({ el: e, name: (e.innerText || '').trim() })).filter((x) => x.name)
    if (!list.length) return { ok: false, error: '表情面板里没东西' }
    const pick = kw ? (list.find((x) => x.name.includes(kw)) || list[0]) : list[Math.floor(Math.random() * list.length)]
    pick.el.scrollIntoView({ block: 'nearest' })
    const r = pick.el.getBoundingClientRect()
    return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, name: pick.name, names: list.map((x) => x.name).slice(0, 12) }
  })()`)
  if (!hit?.ok) return hit
  for (const type of ['mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  // 有的表情是"点一下直接发"，有的是"塞进输入框" —— 后者补一个 Enter
  const editorText = await browser.eval(`(() => { const ed = [...document.querySelectorAll('div[contenteditable="true"]')].find((e) => /messageEditor/.test(e.className || '')); return ed ? (ed.innerText || '').trim() : '' })()`)
  if (editorText) { await clickSend(browser); await sleep(800) }
  let preview = ''
  try { await openChat(browser); preview = await readListPreview(browser, to) } catch { /* 预览拿不到不影响 */ }
  return { ok: true, to, sticker: hit.name, sent: true, preview, editorText }
}

/**
 * 发一张本地图片（当"自己的表情包"用）。
 * 网页版有上传入口：<input type=file>；用 CDP 的 DOM.setFileInputFiles 塞文件，比模拟点选文件框稳。
 */
export async function sendImage(browser, { to, file }) {
  await openChat(browser)
  let conv = await openConversation(browser, to)
  for (let i = 0; i < 2 && !conv?.opened; i++) {
    await sleep(1200)
    conv = await openConversation(browser, to)
  }
  if (!conv?.ok) return { ok: false, error: `找不到会话「${to}」` }

  const doc = await browser.send('DOM.getDocument', { depth: -1 })
  const node = await browser.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  if (!node?.nodeId) return { ok: false, error: '找不到上传入口' }
  await browser.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] })
  await sleep(2500)

  // 网页版选完文件会弹一个「发送文件」确认框（MsgInputSendFileModal），必须点它的「发送」
  const modalBtn = await browser.eval(`(() => {
    const modal = document.querySelector('[class*="MsgInputSendFileModal"]')
    const scope = modal || document
    const isSendText = (e) => (e.innerText || '').trim() === '发送' && e.offsetParent
    const el = [...scope.querySelectorAll('*')].find((e) => isSendText(e) && e.children.length === 0)
      || [...scope.querySelectorAll('*')].find(isSendText)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  // 上传确认弹窗的「发送」——用共用的发送动作（找不到按钮会退回回车）
  await clickSend(browser, { scope: '[class*="MsgInputSendFileModal"]' })
  await sleep(2500)

  // 有的图是"选完直接发"，有的是"进输入框待发"
  const editorText = await browser.eval(`(() => { const ed = [...document.querySelectorAll('div[contenteditable="true"]')].find((e) => /messageEditor/.test(e.className || '')); return ed ? (ed.innerText || '').trim() : '' })()`)
  if (editorText) { await pressEnter(browser); await sleep(1200) }

  let preview = ''
  try { await openChat(browser); preview = await readListPreview(browser, to) } catch { /* 预览拿不到不影响 */ }
  return { ok: true, to, file, preview, editorText }
}

/**
 * 打开会话，同时把它真正的**会话 id**抓下来（抖音只在 imapi 的 protobuf 请求体里带 id）。
 * 返回 { ok, opened, conversationId, name } —— id 抓不到不算失败，只是这次没同步上。
 */
export async function openConversationWithId(browser, name) {
  await browser.send('Network.enable', {})
  let captured = ''
  const listener = (p) => {
    const u = p?.request?.url || ''
    if (!/get_by_conversation/.test(u)) return
    const m = String(p?.request?.postData || '').match(/(\d{16,20})/)
    if (m) captured = m[1]
  }
  browser.on('Network.requestWillBeSent', listener)
  try {
    const hit = await openConversation(browser, name)
    await sleep(1600)
    return { ...hit, conversationId: captured }
  } finally {
    browser.off('Network.requestWillBeSent', listener)
  }
}

/** 列出当前会话列表里可见的会话名（去重、按显示顺序） */
export async function listConversations(browser) {
  const out = await browser.eval(`(() => {
    const names = []
    for (const el of [...document.querySelectorAll('[class*="conversationConversationItem"]')]) {
      const first = (el.innerText || '').split('\\n')[0].trim()
      if (first && !names.includes(first)) names.push(first)
    }
    return names
  })()`)
  return Array.isArray(out) ? out : []
}

/**
 * 就地发送：**假设当前已经打开着目标会话**（监听循环里刚读完消息，会话就是开着的）。
 * 省掉「重开页面 + 重新点会话 + 回读」这三段，实测能砍掉一大半延迟。
 */
export async function sendInPlace(browser, { text, at = '' }) {
  const hasEditor = await browser.eval(`Boolean([...document.querySelectorAll('div[contenteditable="true"]')].find((e) => /messageEditor/.test(e.className || '')))`)
  if (!hasEditor) return { ok: false, error: '当前没有打开的会话（编辑器不在）' }
  let picked = ''
  if (at) {
    const atInfo = await mention(browser, at)
    if (!atInfo.ok) return { ok: false, error: `@${at} 没成功：${atInfo.error}` }
    picked = atInfo.picked || at
    await typeText(browser, text, { click: false })
  } else {
    await typeText(browser, text)
  }
  const how = await clickSend(browser)
  await sleep(700)
  return { ok: true, sent: true, at: picked, via: how.via, appeared: true }
}

/** 当前是不是已经开着某个会话的输入框（廉价判断，用于免掉重复点开会话） */
export async function hasEditor(browser) {
  return await browser.eval('Boolean([...document.querySelectorAll(\'div[contenteditable="true"]\')].find((e) => /messageEditor/.test(e.className || \'\')))')
}
/**
 * 点「发送」——所有发消息的地方共用这一个动作（使用者 2026-11-09：发送做成常用键）。
 * 顺序：先找指定容器里的发送按钮（比如上传确认弹窗），再找整页的，最后回退回车。
 */
export async function clickSend(browser, { scope = '' } = {}) {
  await humanPauseBeforeClick()
  const pos = await browser.eval(`(() => {
    const root = ${scope ? `(document.querySelector(${JSON.stringify(scope)}) || document)` : 'document'}
    // 上传弹窗里按钮叫「发送（1）」，所以按前缀匹配，不用全等
    const isSend = (e) => /^发送(（\\s*\\d+\\s*）)?$/.test((e.innerText || '').trim()) && e.offsetParent
    const el = [...root.querySelectorAll('*')].find((e) => isSend(e) && e.children.length === 0)
      || [...root.querySelectorAll('*')].find(isSend)
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!pos) {
    await pressEnter(browser)
    return { ok: true, via: 'enter' }
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  }
  await sleep(600)
  return { ok: true, via: 'button', x: pos.x, y: pos.y }
}
