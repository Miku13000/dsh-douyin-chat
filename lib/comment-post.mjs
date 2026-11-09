/**
 * lib/comment-post.mjs —— 在视频下发一条评论，并真正 @ 到人。
 *
 * 为什么必须走 UI：API 直发的 mention 会被服务端剥掉 sec_uid（名字不蓝、对方收不到通知）。
 *
 * 顺序（关键：**先确保评论面板打开**，否则编辑器不挂载）：
 *   ① 打开作品页 → 等作品加载完
 *   ② 评论面板没开就先点开（评论图标 / 「评论(N)」标签），等到评论区可见
 *   ③ #comment-input-container 滚进视口 → 真实鼠标点开
 *   ④ 点 .public-DraftEditor-content 聚焦
 *   ⑤ CDP 键盘事件打「@」（execCommand / insertText 不触发弹层）
 *   ⑥ 弹层里按昵称找最窄的叶子节点 → 真实鼠标点选
 *   ⑦ 补正文 → 点右下角红色箭头发布 → 复核
 */
import { sleep } from './util.mjs'

const SEL = {
  box: '#comment-input-container',
  editor: '.public-DraftEditor-content',
}

const CORE_JS = `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && e.offsetParent !== null }
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }
`

async function mouseClick(browser, pt) {
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 })
  await sleep(120)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(60)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 })
}

/** 评论区可见吗 */
async function commentsOpen(browser) {
  return browser.eval(`(() => {${CORE_JS}
    return [...document.querySelectorAll('[data-e2e="comment-list"], [data-e2e="comment-item"]')].some(vis)
  })()`)
}

/** ② 打开评论面板（没开就点图标/标签，最多等 15 秒） */
async function ensureCommentsPanel(browser, timeoutMs = 15_000) {
  if (await commentsOpen(browser)) return true
  const deadline = Date.now() + timeoutMs
  let clicked = false
  while (Date.now() < deadline) {
    if (await commentsOpen(browser)) return true
    if (!clicked) {
      const pt = await browser.eval(`(() => {${CORE_JS}
        const tab = [...document.querySelectorAll('div,span,button')]
          .find((e) => vis(e) && /^评论[（(][0-9万.]+[）)]$/.test((e.innerText || '').replace(/\\s/g, '')))
        const icon = [...document.querySelectorAll('[data-e2e="feed-comment-icon"], [data-e2e="comment-icon"]')].find(vis)
        const btn = tab || icon
        if (!btn) return null
        btn.scrollIntoView({ block: 'nearest' })
        return center(btn)
      })()`)
      if (pt) { await mouseClick(browser, pt); clicked = true }
    }
    await sleep(500)
  }
  return await commentsOpen(browser)
}

/** ③ 点开输入区并等到编辑器挂载 */
async function openEditor(browser) {
  const box = await browser.eval(`(() => {${CORE_JS}
    const el = document.querySelector('${SEL.box}')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    return center(el)
  })()`)
  if (!box) return null

  const findEditor = async (rounds) => {
    for (let i = 0; i < rounds; i++) {
      const pt = await browser.eval(`(() => {${CORE_JS}
        const ed = [...document.querySelectorAll('${SEL.editor}')].find(vis)
        return ed ? center(ed) : null
      })()`)
      if (pt) return pt
      await sleep(700)
    }
    return null
  }

  // ⭐ 先点评论图标，让评论区真正展开（不点直接点输入框经常挂不上编辑器）
  try {
    const icon = await browser.eval(`(() => {${CORE_JS}
      const ic = document.querySelector('[data-e2e="feed-comment-icon"]')
      if (!ic) return null
      ic.scrollIntoView({ block: 'center' })
      return center(ic)
    })()`)
    if (icon) { await mouseClick(browser, icon); await sleep(1500) }
  } catch { /* 没有图标就跳过 */ }

  await mouseClick(browser, box)
  let ed = await findEditor(14)

  // 还是没出来 → 试 #comment-input-container 那一层
  if (!ed) {
    try {
      const cont = await browser.eval(`(() => {${CORE_JS}
        const c = document.querySelector('#comment-input-container, [class*="commentInput"], [class*="comment-input"]')
        if (!c) return null
        c.scrollIntoView({ block: 'center' })
        return center(c)
      })()`)
      if (cont) { await mouseClick(browser, cont); ed = await findEditor(10) }
    } catch { /* 忽略 */ }
  }

  if (!ed) {
    // 兜底：点「留下你的精彩评论」那行提示字
    const ph = await browser.eval(`(() => {${CORE_JS}
      const hit = [...document.querySelectorAll('div,span,p')]
        .find((e) => vis(e) && /留下你的精彩评论|善语结善缘|说点什么/.test(e.innerText || '') && (e.innerText || '').length < 30)
      if (!hit) return null
      hit.scrollIntoView({ block: 'center' })
      return center(hit)
    })()`)
    if (ph) { await mouseClick(browser, ph); ed = await findEditor(8) }
  }
  if (!ed) {
    await mouseClick(browser, box)
    ed = await findEditor(8)
  }
  return ed
}

/** ⑤ 打一个字符（Draft.js 只认带 code/虚拟键码的键盘事件） */
async function typeAt(browser) {
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: '@', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50,
  })
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50,
  })
}

/** ⑥ 弹层里按昵称找最窄的叶子节点 */
async function mentionRow(browser, name) {
  return browser.eval(`(() => {${CORE_JS}
    const want = ${JSON.stringify(String(name || '').trim())}
    // 抖音的 @ 弹层类名是 atBox（实测），mention/suggest 这些是别的站点的叫法，一起留着兜底
    const roots = [...document.querySelectorAll('[class*="atBox"],[class*="mention"],[class*="Mention"],[class*="suggest"],[class*="candidate"],[role="listbox"]')].filter(vis)
    // 🔴 严格匹配：昵称必须「完全等于」目标名，绝不模糊命中（防 @ 错人）
    const leaves = []
    for (const root of roots) {
      for (const e of [root, ...root.querySelectorAll('*')]) {
        if (!vis(e) || e.children.length) continue
        const t = (e.innerText || '').trim()
        if (!t || t !== want) continue
        const r = e.getBoundingClientRect()
        leaves.push({ text: t.slice(0, 40), ...center(e), area: r.width * r.height })
      }
    }
    if (!leaves.length) return { err: 'no-exact', text: want }
    // 同名的不止一个 → 认不准是谁，宁可放弃
    const uniq = []
    for (const l of leaves) {
      const dup = uniq.find((u) => Math.abs(u.x - l.x) < 4 && Math.abs(u.y - l.y) < 4)
      if (!dup) uniq.push(l)
    }
    if (uniq.length > 1) return { err: 'ambiguous', count: uniq.length, text: want }
    uniq.sort((a, b) => a.area - b.area)
    return uniq[0]
  })()`)
}

/** ⑥-b 弹层按「抖音号」过滤后取唯一一行（抖音号唯一，比昵称可靠） */
async function mentionRowById(browser, id) {
  return browser.eval(`(() => {${CORE_JS}
    const want = ${JSON.stringify(String(id || '').trim())}
    const roots = [...document.querySelectorAll('[class*="atBox"],[class*="mention"],[class*="Mention"],[class*="suggest"],[class*="candidate"],[role="listbox"]')].filter(vis)
    const rows = []
    for (const root of roots) {
      for (const e of [root, ...root.querySelectorAll('*')]) {
        if (!vis(e) || e.children.length) continue
        const t = (e.innerText || '').trim()
        if (!t) continue
        const r = e.getBoundingClientRect()
        rows.push({ text: t.slice(0, 40), ...center(e), area: r.width * r.height, hasId: t.indexOf(want) >= 0 })
      }
    }
    if (!rows.length) return { err: 'empty' }
    // 只留「唯一一行」：抖音号过滤后弹层通常只剩一个人
    const uniq = []
    for (const l of rows) {
      const dup = uniq.find((u) => Math.abs(u.x - l.x) < 6 && Math.abs(u.y - l.y) < 6)
      if (!dup) uniq.push(l)
    }
    if (uniq.length > 2) return { err: 'ambiguous', count: uniq.length, text: uniq.slice(0, 3).map((x) => x.text) }
    uniq.sort((a, b) => a.area - b.area)
    return { ...uniq[0], count: uniq.length }
  })()`)
}

/** ⑦ 发布按钮：输入框右下角红色箭头 */
async function publishButton(browser) {
  return browser.eval(`(() => {${CORE_JS}
    const box = document.querySelector('${SEL.box}')
    if (!box) return null
    const r0 = box.getBoundingClientRect()
    const cands = [...box.querySelectorAll('svg, button, [role="button"], span, div')]
    const hits = []
    for (const e of cands) {
      if (!vis(e)) continue
      const r = e.getBoundingClientRect()
      if (r.width < 12 || r.width > 60) continue
      const nearBR = r.x > r0.x + r0.width * 0.55 && r.y > r0.y + r0.height * 0.2
      const svg = e.tagName.toLowerCase() === 'svg'
      const fill = String((e.getAttribute && e.getAttribute('fill')) || '')
      const cls = String((e.className && e.className.baseVal) || e.className || '')
      const reddish = /fe2c55|254,\\s*44|send|publish|发送/i.test(fill + ' ' + cls)
      if (nearBR && (svg || reddish)) hits.push({ ...center(e), area: r.width * r.height })
    }
    if (!hits.length) return null
    hits.sort((a, b) => a.area - b.area)
    return hits[0]
  })()`)
}

/**
 * 发评论（可选 @ 某人）
 */
export async function postComment(browser, { url, text = '', at = '', atId = '', dry = false, awemeId = '' }) {
  const target = url || (awemeId ? 'https://www.douyin.com/video/' + awemeId : '')
  if (!target) return { ok: false, error: '缺视频地址' }

  // 页面加载时好时坏：最多重载两次，直到评论面板真的出来
  let panel = false
  for (let attempt = 1; attempt <= 2 && !panel; attempt++) {
    await browser.goto(target, 14_000)
    await sleep(2500 + attempt * 1500)
    panel = await ensureCommentsPanel(browser, 18_000)
  }
  if (!panel) return { ok: false, error: '评论面板没打开（重载 2 次、每次等 18 秒仍无评论区）' }

  // ③④ 编辑器
  const editor = await openEditor(browser)
  if (!editor) return { ok: false, error: '点了输入区，但 Draft 编辑器没挂载（试了 3 轮）' }
  await mouseClick(browser, editor)
  await sleep(500)

  // ⑤⑥ @
  let mentionPicked = ''
  if (atId) {
    // ⭐ 优先用抖音号：唯一，弹层过滤后只剩一行人，不会认错
    await typeAt(browser)
    await sleep(900)
    await browser.send('Input.insertText', { text: String(atId) })
    await sleep(1200)
    let rowId = await mentionRowById(browser, atId)
    for (let i = 0; i < 8 && rowId && rowId.err === 'empty'; i++) { await sleep(800); rowId = await mentionRowById(browser, atId) }
    if (!rowId || rowId.err) {
      await browser.eval(`(() => { const ed = document.querySelector('${SEL.editor}'); if (ed) { ed.focus(); document.execCommand('selectAll'); document.execCommand('delete') } return true })()`)
      return { ok: false, error: '用抖音号 ' + atId + ' 过滤弹层失败：' + JSON.stringify(rowId).slice(0, 160) }
    }
    await mouseClick(browser, { x: rowId.x, y: rowId.y })
    await sleep(1200)
    mentionPicked = rowId.text
  } else if (at) {
    await typeAt(browser)
    await sleep(2000)
    let row = await mentionRow(browser, at)
    for (let i = 0; i < 6 && !row; i++) { await sleep(800); row = await mentionRow(browser, at) }
    if (!row) {
      await browser.eval(`(() => { const ed = document.querySelector('${SEL.editor}'); if (ed) { ed.focus(); document.execCommand('selectAll'); document.execCommand('delete') } return true })()`)
      return { ok: false, error: '打了 @ 但弹层里没出现「' + at + '」' }
    }
    await mouseClick(browser, { x: row.x, y: row.y })
    await sleep(1200)
    mentionPicked = row.text
  }

  // ⑦ 正文
  if (text) {
    await browser.eval(`(() => {
      const ed = document.querySelector('${SEL.editor}')
      if (!ed) return false
      ed.focus()
      const sel = window.getSelection()
      if (sel && sel.rangeCount) sel.getRangeAt(0).collapse(false)
      document.execCommand('insertText', false, ' ' + ${JSON.stringify(text)})
      return true
    })()`)
    await sleep(800)
  }

  const draft = await browser.eval(`(() => { const ed = document.querySelector('${SEL.editor}'); return ed ? (ed.innerText || '') : '' })()`)
  if (dry) return { ok: true, dry: true, mention: mentionPicked, draft: String(draft || '').slice(0, 200) }

  let btn = await publishButton(browser)
  if (!btn) {
    // 兜底 1：把编辑框里所有可点的 svg 列出来，挑最靠右下那个
    btn = await browser.eval(`(() => {${CORE_JS}
      const ed = document.querySelector('${SEL.editor}')
      if (!ed) return null
      let scope = ed
      for (let i = 0; i < 5 && scope.parentElement; i++) scope = scope.parentElement
      const items = [...scope.querySelectorAll('svg,button,[role="button"]')].filter(vis).map((e) => {
        const r = e.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height }
      }).filter((x) => x.w >= 10 && x.w <= 60)
      if (!items.length) return null
      items.sort((a, b) => (b.x + b.y) - (a.x + a.y))
      return items[0]
    })()`)
  }
  if (!btn) {
    // 兜底 2：回车发送
    const ed = await browser.eval(`(() => {${CORE_JS}
      const e2 = document.querySelector('${SEL.editor}')
      if (!e2) return null
      e2.focus()
      return center(e2)
    })()`)
    if (ed) {
      await mouseClick(browser, ed)
      await sleep(300)
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await sleep(2500)
    }
  } else {
    await mouseClick(browser, btn)
    await sleep(2500)
  }

  const after = await browser.eval(`(() => {${CORE_JS}
    const ed = document.querySelector('${SEL.editor}')
    const empty = !ed || !(ed.innerText || '').trim()
    const items = [...document.querySelectorAll('[data-e2e="comment-item"]')].map((e) => e.innerText || '').join('\\n')
    const lead = ${JSON.stringify(String(text || '').slice(0, 10))}
    return { empty, appeared: lead ? items.indexOf(lead) >= 0 : true }
  })()`)

  return {
    ok: true,
    published: true,
    mention: mentionPicked,
    editorCleared: Boolean(after && after.empty),
    appeared: Boolean(after && after.appeared),
  }
}
