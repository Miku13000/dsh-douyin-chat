# 结构说明

```
bin/          命令行入口（每个都能单独跑）
lib/          实现库
client.js     侧栏面板（DSH 客户端插件）
index.js      宿主半端（保证 3110 服务活着）
```

## bin/ 入口

| 文件 | 干什么 |
|---|---|
| `service.mjs` | 常驻服务，3110 端口，所有 HTTP 接口都在这 |
| `watch.mjs` | 群聊监听（6 秒一轮） |
| `watch-dm.mjs` | 私信监听（6 秒一轮）+ 任务指令执行 |
| `login.mjs` | 扫码登录，存 Cookie |
| `account.mjs` | 多账号：列出 / 新增 / 切换 |
| `send.mjs` `read.mjs` `sticker.mjs` | 发消息 / 读消息 / 发表情 |
| `comment-post.mjs` `comments.mjs` | 发评论 / 读评论 / 回复评论 |
| `share.mjs` | 把视频以卡片分享给私聊 |
| `recommend.mjs` | 拉推荐流候选并打分 |
| `proactive.mjs` | 主动开口（私信 / 群） |
| `browsers.mjs` `look.mjs` `notices.mjs` | 浏览器管理 / 截图看一眼 / 通知 |

## lib/ 实现

**基础**

| 文件 | 作用 |
|---|---|
| `cdp.mjs` | 手写的 CDP 客户端（无头 Chrome 的唯一入口） |
| `paths.mjs` `prefs.mjs` `util.mjs` | 路径约定 / 偏好读写 / 杂项 |
| `account.mjs` `browsers.mjs` | 账号与浏览器选择 |

**抖音操作**

| 文件 | 作用 |
|---|---|
| `douyin.mjs` | 打开会话、读消息、发消息、@ 人 |
| `human.mjs` | 拟人节奏（打字间隔、点击前后停顿） |
| `comment-post.mjs` | 发评论并 @ 人（严格匹配：抖音号过滤 + 唯一性检查） |
| `comment-reply.mjs` | 回复评论区某条评论（UI 点击，可回任何人） |
| `sharecard.mjs` `share.mjs` | 分享卡片（hover 展开面板） |
| `comments.mjs` `notices.mjs` `eyes.mjs` | 读评论 / 读通知 / 截图 |
| `recommend.mjs` `memes.mjs` | 推荐打分 / 表情库 |

**监听与去重**

| 文件 | 作用 |
|---|---|
| `messages.mjs` | **指纹表**（抖音 DOM 没消息 id，用「发送者+正文」当指纹）、自己消息判定 |
| `groups.mjs` | 群名 ↔ 群号同步 |
| `traffic.mjs` `valley.mjs` | 消息量统计 / 说话时段判断 |
| `guard.mjs` | 限速（每天几条、间隔几分钟，可自定义） |

**AI 相关**

| 文件 | 作用 |
|---|---|
| `reply.mjs` | 生成回复（按场景分级提示词）+ 敏感内容清洗 |
| `soul.mjs` | 人设与记忆（本地 / 共享两条通道） |
| `vision.mjs` | 看懂表情包（modlens + agy，可选依赖） |
| `plan.mjs` `stats.mjs` | 自动计划 / 今日计数 |

## 去重是三道闸

1. **指纹表**（`messages.mjs`）：处理过的消息不再当新的
2. **触发去重**：同一条消息 30 分钟内不重复调模型（省 token）
3. **内容去重 + 发送前回读**：同一句话不重发；发之前先读一眼，有就不发

## 状态文件

| 文件 | 内容 |
|---|---|
| `~/.dsh/fish/config.json` | 偏好设置 |
| `~/.dsh/fish/watch-state.json` | 群聊的指纹表、去重时间戳 |
| `~/.dsh/fish/watch-dm-state.json` | 私信的指纹表、已发文本、待办任务 |
| `~/.dsh/fish/guard-state.json` | 限速计数 |
| `~/.dsh/fish/vision-cache.json` | 图片识别缓存 |
