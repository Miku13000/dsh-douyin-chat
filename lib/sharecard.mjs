/**
 * lib/sharecard.mjs —— 用抖音自己的「分享给朋友」把视频以**卡片**发给好友。
 *
 * 思路（借道 dsh-douyin-scroll 的 tools/card-share.mjs，已验证过的路径）：
 *   视频页 → 真实鼠标轨迹 hover 分享图标 → 面板展开 →
 *   找「昵称」那一行 + sec_uid 去重 → 点它的「分享」→ 卡片发出
 *
 * ⚠️ 分享图标没有 onClick，是 hover 弹窗：必须用**真实鼠标轨迹**移过去，
 *    直接 el.click() 打不开（踩过，见对方注释）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function move(browser, x, y) {
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
}

async function click(browser, x, y) {
  await move(browser, x, y)
  await sleep(120)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

export async function shareCard(browser, { awemeId, who, toId = '' }) {
  if (!awemeId || !who) return { ok: false, error: '缺 awemeId 或 who' }
  await browser.goto(`https://www.douyin.com/video/${awemeId}`, 9000)
  await sleep(6500)

  const pos = await browser.eval(`(() => {
    const ic = document.querySelector('[data-e2e="video-share-icon-container"]')
    if (!ic) return null
    const r = ic.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (!pos?.x) return { ok: false, error: '找不到分享图标（视频页没加载好）' }

  // 真实轨迹 hover：一步到位有时不触发弹窗
  await move(browser, 20, 20)
  await sleep(250)
  for (let i = 1; i <= 8; i++) {
    await move(browser, Math.round(20 + (pos.x - 20) * i / 8), Math.round(20 + (pos.y - 20) * i / 8))
    await sleep(70)
  }
  await move(browser, pos.x, pos.y)
  await sleep(2000)

  const panel = await browser.eval(`(() => {
    const sc = document.querySelector('[data-e2e="video-share-container"]')
    return sc ? (sc.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) : ''
  })()`)
  if (!panel) return { ok: false, error: '分享面板没展开' }

  const found = await browser.eval(`(() => {
    const who = ${JSON.stringify(String(who))}
    const sc = document.querySelector('[data-e2e="video-share-container"]')
    if (!sc) return { err: 'no-panel' }
    function secOf(node) {
      const fk = Object.keys(node).find((k) => k.indexOf('__reactFiber$') === 0)
      if (!fk) return ''
      let f = node[fk], d = 0
      while (f && d < 14) {
        const p = f.memoizedProps
        if (p && typeof p === 'object') {
          for (const k in p) { const v = p[k]; if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid) }
        }
        f = f.return; d++
      }
      return ''
    }
    const nodes = [...sc.querySelectorAll('div,span,p')]
      .filter((e) => (e.innerText || '').trim() === who)
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)
    if (!nodes.length) return { err: 'no-name', text: (sc.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) }
    const out = []
    for (const nameNode of nodes) {
      let row = nameNode
      for (let i = 0; i < 6 && row; i++) {
        const btn = [...row.querySelectorAll('div,span,button')].find((e) => (e.innerText || '').trim() === '分享')
        if (btn) {
          const r = btn.getBoundingClientRect()
          if (r.width > 16 && r.height > 12) {
            out.push({ nick: who, sec_uid: secOf(row) || secOf(nameNode), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
          }
          break
        }
        row = row.parentElement
      }
    }
    const seen = new Set()
    const uniq = out.filter((o) => { const k = o.sec_uid || (o.x + ',' + o.y); if (seen.has(k)) return false; seen.add(k); return true })
    return { candidates: uniq }
  })()`)

  if (found?.err) return { ok: false, error: '找不到该好友那一行', detail: found, panel }
  let cands = found?.candidates || []
  if (toId) {
    cands = cands.filter((c) => c.sec_uid === toId)
    if (!cands.length) return { ok: false, error: '分享面板里没有这个人（面板只列最近分享过的人）', panel }
  }
  if (cands.length > 1) {
    return {
      ok: false,
      error: '面板里有多个同名的人，不敢猜',
      candidates: cands.map((c) => c.sec_uid),
      hint: '用 toId 指定 sec_uid',
    }
  }
  if (!cands.length) return { ok: false, error: '面板里没有这个人', panel }

  const b = cands[0]
  await click(browser, b.x, b.y)
  await sleep(2500)
  return { ok: true, via: 'card', awemeId, to: who, sec_uid: b.sec_uid || '' }
}
