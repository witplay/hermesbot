const util = require('./util')

const CHANNEL = {
  session: { id: 'session', label: '会话', badge: 'badge-session' },
  feishu: { id: 'feishu', label: '飞书', badge: 'badge-feishu' },
  api: { id: 'api', label: 'API', badge: 'badge-api' },
  cron: { id: 'cron', label: '定时', badge: 'badge-cron' }
}

const SOURCE_TEXT = {
  local: '移动端',
  cli: '命令行',
  desktop: '桌面端',
  oneshot: '一次性任务',
  feishu: '飞书',
  api_server: 'API',
  cron: '定时任务'
}

function tsMs(value) {
  if (!value) return 0
  const n = Number(value)
  if (!isNaN(n)) return n < 1e12 ? n * 1000 : n
  const parsed = new Date(value).getTime()
  return isNaN(parsed) ? 0 : parsed
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
}

function clipText(value, max) {
  const text = cleanText(value)
  if (!max || text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function channelOf(source) {
  const src = String(source || '').toLowerCase()
  if (src === 'feishu') return 'feishu'
  if (src === 'api_server' || src === 'api') return 'api'
  if (src === 'cron') return 'cron'
  return 'session'
}

function channelInfo(channel) {
  return CHANNEL[channel] || CHANNEL.session
}

function sourceText(source) {
  if (!source) return '未知来源'
  const key = String(source).toLowerCase()
  return SOURCE_TEXT[key] || source
}

function workspaceName(cwd) {
  if (!cwd) return '未指定工作区'
  const clean = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!clean) return '/'
  const parts = clean.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : '/'
}

function shortPath(cwd) {
  if (!cwd) return ''
  let path = String(cwd)
  if (path === '/root' || path.indexOf('/root/') === 0) path = '~' + path.slice(5)
  if (path.length > 46) path = '…' + path.slice(-45)
  return path
}

// 定时任务的每次运行都会留下会话；部分服务端会在会话行上带运行状态，
// 有就直读，没有则按「已完成的运行默认成功」处理。
function sessionStatus(row) {
  const okFlag = row.ok
  if (okFlag === false || okFlag === 0 || okFlag === 'false' || okFlag === '0') return false
  const error = row.error || row.last_error || row.error_text
  if (error) return false
  const raw = String(row.status || row.last_status || row.run_status || row.cron_status || '').toLowerCase()
  if (/(fail|error|timeout|timed out|cancel|abort)/.test(raw)) return false
  // 部分服务端不在会话行上带运行状态，失败记录会直接体现在标题或正文开头。
  if (/(失败|错误|异常|超时|failed|timeout)/i.test(String(row.title || ''))) return false
  if (/^(error|traceback|exception|执行失败|运行失败|任务失败)/i.test(String(row.preview || '').trim())) return false
  return true
}

function session(row) {
  const source = row.source || 'local'
  const channel = channelOf(source)
  const cwd = row.cwd || ''
  const info = channelInfo(channel)
  const last = tsMs(row.last_active || row.started_at)
  const messageCount = Number(row.message_count) || 0
  const wsName = cwd ? workspaceName(cwd) : '未指定工作区'
  const ok = sessionStatus(row)
  const preview = clipText(row.preview, 120)
  const rawTitle = clipText(row.title, 80)
  const previewIsTitle = !rawTitle && !!preview
  const title = rawTitle || clipText(preview, 32) || (messageCount > 0 ? sourceText(source) + '会话' : '未命名会话')
  const metaLine = messageCount > 0 ? sourceText(source) + ' · ' + messageCount + ' 条消息' : '暂无消息内容'
  return {
    id: row.id,
    title: title,
    preview: preview && !previewIsTitle ? preview : metaLine,
    messageCount: messageCount,
    hasContent: messageCount > 0 || !!rawTitle || !!preview,
    active: !!row.is_active,
    source: source,
    channel: channel,
    channelLabel: info.label,
    channelBadge: info.badge,
    cwd: cwd,
    wsName: wsName,
    wsShort: shortPath(cwd),
    model: row.model || '',
    profile: row.profile || '',
    // 定时任务会话可能带上来源任务 ID，用于把消息归到具体任务历史里。
    jobId: row.cron_job_id || row.job_id || row.cron_id || row.jobId || '',
    ok: ok,
    statusText: ok ? '成功' : '失败',
    lastActive: last,
    timeText: util.formatTime(row.last_active || row.started_at),
    timeFull: util.formatDateTime(row.last_active || row.started_at),
    startedText: util.formatDateTime(row.started_at)
  }
}

function group(items) {
  const map = {}
  const order = []
  ;(items || []).forEach((item) => {
    const key = item.cwd || '__empty__'
    if (!map[key]) {
      map[key] = {
        key: key,
        cwd: item.cwd || '',
        name: item.cwd ? workspaceName(item.cwd) : '未指定工作区',
        short: shortPath(item.cwd),
        items: [],
        last: 0
      }
      order.push(key)
    }
    map[key].items.push(item)
    if (item.lastActive > map[key].last) map[key].last = item.lastActive
  })
  return order
    .map((key) => map[key])
    .sort((a, b) => b.last - a.last)
    .map((g) => {
      g.items.sort((a, b) => b.lastActive - a.lastActive)
      g.count = g.items.length
      return g
    })
}

function recentWorkspaces(items) {
  const map = {}
  ;(items || []).forEach((item) => {
    if (!item.cwd) return
    if (!map[item.cwd]) {
      map[item.cwd] = {
        cwd: item.cwd,
        name: workspaceName(item.cwd),
        short: shortPath(item.cwd),
        count: 0,
        last: 0
      }
    }
    map[item.cwd].count += 1
    if (item.lastActive > map[item.cwd].last) map[item.cwd].last = item.lastActive
  })
  return Object.keys(map)
    .map((key) => map[key])
    .sort((a, b) => (b.last - a.last) || (b.count - a.count))
}

module.exports = {
  CHANNEL,
  tsMs,
  channelOf,
  channelInfo,
  sourceText,
  workspaceName,
  shortPath,
  session,
  group,
  recentWorkspaces
}
