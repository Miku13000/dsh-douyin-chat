/**
 * lib/human.mjs —— 让自动化操作更像人：慢一点、有停顿、有抖动。
 *
 * 用户 2026-11-09 要求「操作慢一点」：不是动作频率，而是每一次点击/输入之间的节奏。
 * 所有参数都能在 prefs.human 里调（缺省就是下面的默认值）。
 */
import { load as loadPrefs } from './prefs.mjs'

export const DEFAULT_HUMAN = {
  enabled: true,
  typeMinMs: 90,      // 每个字之间的停顿下限
  typeMaxMs: 220,     // 上限
  beforeClickMs: [180, 450],   // 点击前停顿区间
  afterClickMs: [280, 700],    // 点击后停顿区间
  betweenActions: [600, 1600], // 两个大动作之间
}

export function humanConfig() {
  try {
    const p = loadPrefs().human || {}
    return { ...DEFAULT_HUMAN, ...p }
  } catch { return DEFAULT_HUMAN }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 区间随机 */
export function randRange(lo, hi) {
  const a = Math.max(0, Number(lo) || 0)
  const b = Math.max(a, Number(hi) || a)
  return Math.floor(a + Math.random() * (b - a))
}

/** 点击前后按人节奏停顿 */
export async function humanPauseBeforeClick() {
  const c = humanConfig()
  if (c.enabled === false) return
  await sleep(randRange(c.beforeClickMs?.[0], c.beforeClickMs?.[1]))
}

export async function humanPauseAfterClick() {
  const c = humanConfig()
  if (c.enabled === false) return
  await sleep(randRange(c.afterClickMs?.[0], c.afterClickMs?.[1]))
}

export async function humanPauseBetween() {
  const c = humanConfig()
  if (c.enabled === false) return
  await sleep(randRange(c.betweenActions?.[0], c.betweenActions?.[1]))
}

/**
 * 逐字输入（模拟真人打字）。
 * 中文用 insertText 一次一个字，标点/换行稍慢。
 */
export async function humanType(browser, text) {
  const c = humanConfig()
  const s = String(text || '')
  if (c.enabled === false) {
    await browser.send('Input.insertText', { text: s })
    return
  }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    await browser.send('Input.insertText', { text: ch })
    let d = randRange(c.typeMinMs, c.typeMaxMs)
    if (/[，。！？,.!?\n]/.test(ch)) d += randRange(120, 320)   // 标点后停久一点
    await sleep(d)
  }
}
