/**
 * bin/recommend.mjs —— 拉一批推荐候选（只读）
 *
 *   node bin/recommend.mjs --top 5
 *   node bin/recommend.mjs --pages 2 --top 3 --min-desc 20
 */
import { recommend } from '../lib/recommend.mjs'
import { cookieFile } from '../lib/account.mjs'
import { arg, emit } from '../lib/util.mjs'

const out = await recommend({
  cookieFile: cookieFile(),
  pages: Number(arg('--pages', '3')) || 3,
  top: Number(arg('--top', '10')) || 10,
  minDescLen: Number(arg('--min-desc', '12')) || 12,
  minComments: Number(arg('--min-comments', '3')) || 3,
})
emit(out)
process.exit(out.ok ? 0 : 1)
