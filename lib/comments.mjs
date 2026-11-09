/**
 * lib/comments.mjs —— 读抖音评论 / 回评论。
 *
 * 网页端结构（2026-11-09 实测）：
 *   .comment-mainContent          每条评论的正文
 *   [class*="info-wrap"]          作者名
 *   [class*="stats-container"]    点赞数 + 分享/回复按钮
 *   评论 input: .comment-input-inner-container（点开回复后出现编辑器）
 */

const TIME_LIKE = /^(\d+\s*(秒|分钟|小时|天|周|月)前|\d{1,2}-\d{1,2}|刚刚|·.*)$/

/**
 * 读一条作品下的评论。
 *
 * 走网络层而不是 DOM：页面把评论渲染成一坨嵌套结构，按 class 抓会把整段列表当成一条；
 * 而评论接口 /aweme/v1/web/comment/list/ 的响应是干净 JSON（附带签名，由页面自己发）。
 * 所以做法是：开着 Network 监听，页面加载时截获响应体，直接解析。
 * DOM 只作为兜底（接口没截到时）。
 */
export async function readComments(browser, { url, n = 20 }) {
  await browser.send('Network.enable', {})

  const captured = []
  const onResp = (p) => {
    if (!/comment\/list|comment_list|comment\/reply/i.test(p?.response?.url || '')) return
    captured.push(p.requestId)
  }
  browser.on('Network.responseReceived', onResp)

  try {
    await browser.goto(url, 10_000)
    for (let i = 0; i < 8 && !captured.length; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      // 触发懒加载：滚一下
      await browser.eval('(() => { window.scrollBy(0, 600); return true })()').catch(() => {})
    }
    const items = []
    for (const id of captured.slice(0, 3)) {
      try {
        const body = await browser.send('Network.getResponseBody', { requestId: id })
        const text = body?.body || ''
        const json = JSON.parse(body?.base64Encoded ? Buffer.from(text, 'base64').toString('utf8') : text)
        for (const c of json?.comments || []) {
          items.push({
            who: c?.user?.nickname || '',
            text: String(c?.text || '').trim(),
            like: String(c?.digg_count ?? ''),
            cid: String(c?.cid ?? ''),
            replyTo: String(c?.reply_comment?.cid ?? ''),
          })
        }
      } catch { /* 单条响应解析失败不影响其它 */ }
    }
    if (items.length) return items.slice(0, Math.max(1, Number(n) || 20))
  } finally {
    browser.off('Network.responseReceived', onResp)
  }

  // 兜底：接口没截到（比如缓存命中），退回 DOM 里的叶子正文
  const fallback = await browser.eval('(() => [...document.querySelectorAll(".comment-mainContent")].filter((e) => !e.querySelector(".comment-mainContent")).map((e) => ({ who: "", text: (e.innerText || "").trim().slice(0, 300), like: "" })).filter((x) => x.text).slice(0, ' + (Math.max(1, Number(n) || 20)) + '))()')
  return Array.isArray(fallback) ? fallback : []
}

/** 回某条评论：index 从 0 开始（readComments 的顺序）；text 是回复内容 */
export async function replyComment(browser, { url, index = 0, text }) {
  await browser.goto(url, 10_000)
  await new Promise((r) => setTimeout(r, 4500))
  const pos = await browser.eval(`(() => {
    const bodies = [...[...document.querySelectorAll('.comment-mainContent')].filter((e) => !e.querySelector('.comment-mainContent'))]
    const el = bodies[${Number(index) || 0}]
    if (!el) return null
    let box = el
    for (let i = 0; i < 8 && box.parentElement; i++) {
      if (box.parentElement.querySelectorAll('.comment-mainContent').length > 1) break
      box = box.parentElement
      if (box.querySelector('[class*="avatar"]')) break
    }
    const root = box || el.parentElement
    el.scrollIntoView({ block: 'center' })
    const btn = [...root.querySelectorAll('*')].find((e) => (e.innerText || '').trim() === '回复' && e.children.length === 0)
    const target = btn || root
    const r = target.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), found: Boolean(btn) }
  })()`)
  if (!pos) return { ok: false, error: '这一页没找到那条评论' }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  }
  await new Promise((r) => setTimeout(r, 1500))
  // 点开后出现评论输入框，聚焦输入
  const box = await browser.eval(`(() => {
    const ed = [...document.querySelectorAll('div[contenteditable="true"], textarea')].find((e) => /comment/i.test((e.className || '') + (e.parentElement?.className || '')))
      || document.querySelector('[class*="comment-input"] div[contenteditable="true"]')
      || document.querySelector('[class*="comment-input-inner-container"] div[contenteditable="true"]')
    if (!ed) return null
    const r = ed.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!box) return { ok: false, error: '点了回复但没出现输入框' }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await new Promise((r) => setTimeout(r, 400))
  await browser.send('Input.insertText', { text: String(text) })
  await new Promise((r) => setTimeout(r, 400))
  // 发送：找"发送"按钮；找不到就 Enter
  const sent = await browser.eval(`(() => {
    const btn = [...document.querySelectorAll('button, [role="button"], span, div')]
      .find((e) => (e.innerText || '').trim() === '发送' && e.offsetParent)
    if (btn) { btn.click(); return 'click' }
    return ''
  })()`)
  if (!sent) {
    await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await new Promise((r) => setTimeout(r, 2500))
  return { ok: true, url, index, text, via: sent || 'enter' }
}
