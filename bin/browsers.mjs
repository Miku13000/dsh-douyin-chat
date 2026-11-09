/**
 * bin/browsers.mjs —— 看有哪些浏览器可用 / 切换用哪个。
 *
 *   node bin/browsers.mjs list          # 本机装了哪些
 *   node bin/browsers.mjs show          # 当前用的是哪个（含来源）
 *   node bin/browsers.mjs use edge      # 切成 Edge（写进偏好）
 *   node bin/browsers.mjs use auto      # 自动挑第一个装了的
 */
import { listBrowsers, resolveBrowser, browserSummary } from '../lib/browsers.mjs'
import { save as savePrefs, load as loadPrefs } from '../lib/prefs.mjs'
import { arg, emit } from '../lib/util.mjs'

const cmd = (process.argv[2] || 'show').toLowerCase()

if (cmd === 'list') {
  emit({ ok: true, browsers: listBrowsers() })
} else if (cmd === 'use') {
  const want = String(arg('--id') || process.argv[3] || '').toLowerCase()
  if (!want) { emit({ ok: false, error: '用法: use <chrome|edge|brave|chromium|auto>' }); process.exit(2) }
  if (want !== 'auto') {
    const hit = listBrowsers().find((b) => b.id === want)
    if (!hit) { emit({ ok: false, error: `不认识的浏览器：${want}` }); process.exit(2) }
    if (!hit.exists) { emit({ ok: false, error: `${hit.name} 没有安装（看 list）` }); process.exit(1) }
  }
  const prefs = savePrefs({ browser: { ...(loadPrefs().browser || {}), channel: want } })
  emit({ ok: true, saved: prefs.browser, summary: browserSummary() })
} else {
  emit({ ok: true, summary: browserSummary(), resolved: (() => { try { return resolveBrowser() } catch (e) { return { error: String(e?.message ?? e) } } })() })
}
