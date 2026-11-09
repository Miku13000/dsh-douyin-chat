/**
 * lib/eyes.mjs —— 给抖音这端装「眼睛」。
 *
 * 使用者 2026-11-09 问「抖音这边现在有眼睛吗」：原来只有 DOM 文本，没有画面。
 * 这里补上：无头浏览器截图存盘（CDP Page.captureScreenshot），返回路径 + 页面基本信息，
 * 上层（我/插件工具）读图就能判断「现在屏幕上是什么样」。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from './paths.mjs'

/** 截一张图，存到 ~/.dsh/fish/shots/，返回路径和尺寸信息 */
export async function screenshot(browser, { name = 'shot', fullPage = false } = {}) {
  const dir = join(PATHS.home, 'shots')
  mkdirSync(dir, { recursive: true })
  const r = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage })
  const data = r?.data
  if (!data) throw new Error('截图失败：页面没返回图像')
  const file = join(dir, `${name}-${Date.now()}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/** 页面现状摘要：标题、URL、可见文字量、有没有登录墙/验证码的迹象 */
export async function pageSummary(browser) {
  const info = await browser.eval(`(() => {
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim()
    const flags = []
    if (/登录|扫码登录/.test(text.slice(0, 400))) flags.push('可能未登录')
    if (/验证码|安全验证|验证中间页/.test(document.title + text.slice(0, 200))) flags.push('验证码/风控页')
    if (/验证|滑块|captcha/i.test(text.slice(0, 600))) flags.push('可能有验证码')
    return {
      url: location.href,
      title: document.title,
      chars: text.length,
      head: text.slice(0, 160),
      flags,
    }
  })()`)
  return info
}
