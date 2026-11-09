/**
 * bin/comment-post.mjs —— 在视频下发评论（可选 @ 某人）
 *
 *   node bin/comment-post.mjs --url "https://v.douyin.com/xxx/" --at Sora --text "……" [--dry]
 *   node bin/comment-post.mjs --aweme 7653714725796171046 --text "……"
 *
 * --dry：一路走到"@ 选好 + 正文补完"为止，**不发布**（用来验证流程）
 */
import { Browser, readCookieString } from '../lib/cdp.mjs'
import { cookieFile } from '../lib/account.mjs'
import { postComment } from '../lib/comment-post.mjs'
import { arg, flag } from '../lib/util.mjs'

const url = arg('--url') || ''
const aweme = arg('--aweme') || ''
const text = arg('--text') || ''
const at = arg('--at') || ''
const dry = flag('--dry')

const b = await new Browser().launch({ headless: true })
try {
  await b.setCookies(readCookieString(cookieFile()))
  const r = await postComment(b, { url, awemeId: aweme, text, at, dry })
  console.log(JSON.stringify(r, null, 1))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 1))
} finally {
  await b.close()
}
