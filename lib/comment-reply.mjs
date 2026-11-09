/**
 * lib/comment-reply.mjs —— 回复评论区某一条评论（可以回任何人，不限于自己）
 *
 * 做法（全 UI，不靠接口）：
 *   ① 打开视频页，等评论区渲染
 *   ② 在评论项里找「回复」按钮（按 index 或按文字关键词定位）
 *   ③ 点开后输入正文，点发送
 */
import { sleep } from './util.mjs'

const SEL_ITEM = '[data-e2e="comment-item"]'
const SEL_EDITOR = '.public-DraftEditor-content'

function centerOf(r) { return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }

async function findTarget(browser, { index = 0, match = '' } = {}) {
  return browser.eval(`(() => {
    const items = [...document.querySelectorAll('${SEL_ITEM}')]
    if (!items.length) return { err: 'no-items' }
    let target = null
    if (${JSON.stringify(String(match || ''))}) {
      const kw = ${JSON.stringify(String(match || ''))}
      target = items.find((e) => (e.innerText || '').indexOf(kw) >= 0)
    }
    if (!target) target = items[${Number(index) || 0}] || null
    if (!target) return { err: 'index-out' }

    target.scrollIntoView({ block: 'center' })
    const btns = [...target.querySelectorAll('span,div,button')]
      .filter((e) => (e.innerText || '').trim() === '回复')
      .filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 10 && r.height > 8
      })
    if (!btns.length) return { err: 'no-reply-btn' }
    // 取最右下的那个（底部操作行里的回复）
    btns.sort((a, b) => (b.getBoundingClientRect().x + b.getBoundingClientRect().y) - (a.getBoundingClientRect().x + a.getBoundingClientRect().y))
    const r = btns[0].getBoundingClientRect()
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (target.innerText || '').replace(/\\s+/g, ' ').slice(0, 40) }
  })()`)
}

async function visibleEditor(browser) {
  return browser.eval(`(() => {
    const eds = [...document.querySelectorAll('${SEL_EDITOR}')].filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 40 && r.height > 8
    })
    if (!eds.length) return null
    const ed = eds[eds.length - 1]
    ed.scrollIntoView({ block: 'center' })
    const r = ed.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
}

async function click(browser, p) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 })
  }
}

/** 点「发送」：红色箭头或回车 */
async function submit(browser) {
  const btn = await browser.eval(`(() => {
    const eds = [...document.querySelectorAll('${SEL_EDITOR}')].filter((e) => e.getBoundingClientRect().width > 40)
    if (!eds.length) return null
    let scope = eds[eds.length - 1]
    for (let i = 0; i < 5 && scope.parentElement; i++) scope = scope.parentElement
    const items = [...scope.querySelectorAll('svg,button,[role="button"],div')].filter((e) => {
      const r = e.getBoundingClientRect()
      return r.width >= 14 && r.width <= 60 && r.height >= 14
    }).map((e) => {
      const r = e.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width }
    })
    if (!items.length) return null
    items.sort((a, b) => (b.x + b.y) - (a.x + a.y))
    return items[0]
  })()`)
  if (btn) { await click(browser, btn); return 'click' }
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  return 'enter'
}

/**
 * 回复一条评论
 * @param {object} browser
 * @param {{awemeId?:string,url?:string,index?:number,match?:string,text:string,dry?:boolean}} opts
 */
export async function replyComment(browser, opts = {}) {
  const { awemeId = '', url = '', index = 0, match = '', text = '', dry = false } = opts
  const target = url || (awemeId ? 'https://www.douyin.com/video/' + awemeId : '')
  if (!target) return { ok: false, error: '缺视频地址' }
  if (!text) return { ok: false, error: '缺回复正文' }

  await browser.goto(target, 14_000)
  await sleep(6500)

  const hit = await findTarget(browser, { index, match })
  if (!hit || !hit.ok) return { ok: false, error: '找不到要回复的评论：' + JSON.stringify(hit).slice(0, 120) }

  await click(browser, hit)
  await sleep(1500)

  const ed = await visibleEditor(browser)
  if (!ed) return { ok: false, error: '点了回复但输入框没出现', target: hit.text }
  await click(browser, ed)
  await sleep(400)
  await browser.send('Input.insertText', { text })
  await sleep(900)

  const draft = await browser.eval(`(() => {
    const eds = [...document.querySelectorAll('${SEL_EDITOR}')].filter((e) => e.getBoundingClientRect().width > 40)
    return eds.length ? (eds[eds.length - 1].innerText || '').slice(0, 120) : ''
  })()`)

  if (dry) return { ok: true, dry: true, target: hit.text, draft }

  const how = await submit(browser)
  await sleep(2500)

  const after = await browser.eval(`(() => {
    const body = document.body.innerText || ''
    return { visible: body.indexOf(${JSON.stringify(String(text).slice(0, 8))}) >= 0 }
  })()`)

  return { ok: Boolean(after && after.visible), how, target: hit.text, draft, appeared: Boolean(after && after.visible) }
}
