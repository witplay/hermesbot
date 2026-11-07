const http = require('./http')
const util = require('./util')

// Hermes 的定时任务接口在 bridge 契约里是复数形式（/api/crons*），旧版 dashboard
// 则挂在 /api/cron/jobs 下。当前部署的 /api/crons 会返回 404，因此列表先走旧路径，
// 404/405 时再退回复数路径，避免每次加载都先打一条 404 请求。
const LIST_PATHS = ['/api/cron/jobs', '/api/crons']
const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_MS = 24 * 60 * 60 * 1000

function pad2(n) {
  const v = Number(n) || 0
  return v < 10 ? '0' + v : '' + v
}

function clamp(n, min, max) {
  if (isNaN(n)) return min
  if (n < min) return min
  if (n > max) return max
  return n
}

function tsMs(value) {
  if (value === null || value === undefined || value === '') return 0
  if (value instanceof Date) return value.getTime()
  const n = Number(value)
  if (!isNaN(n) && n > 0) return n < 1e12 ? n * 1000 : n
  const parsed = new Date(String(value)).getTime()
  return isNaN(parsed) ? 0 : parsed
}

// 下次执行时间用「今天 / 明天」表达，列表里比完整日期更易读。
function nextRunText(ms) {
  if (!ms) return ''
  const now = new Date()
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDiff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - startOfToday) / DAY_MS)
  if (dayDiff === 0) return '今天 ' + time
  if (dayDiff === 1) return '明天 ' + time
  if (d.getFullYear() === now.getFullYear()) return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + time
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + time
}

function withProfile(path, profile) {
  if (!profile) return path
  const sep = path.indexOf('?') >= 0 ? '&' : '?'
  return path + sep + 'profile=' + encodeURIComponent(profile)
}

function expressionOf(schedule) {
  if (!schedule) return ''
  if (typeof schedule === 'string') return schedule.trim()
  if (typeof schedule === 'object') {
    const expr = schedule.expression || schedule.expr || schedule.cron || schedule.value || schedule.every
    if (expr) return String(expr).trim()
    const kind = String(schedule.kind || '').toLowerCase()
    const at = schedule.at || schedule.timestamp || schedule.time
    if (kind === 'once' && at) return String(at)
  }
  return ''
}

// 把 cron 表达式 / 间隔 / 一次性时间翻译成中文，服务端自带英文展示时优先用中文。
function humanSchedule(expr) {
  const text = String(expr || '').trim()
  if (!text) return '未设置时间'

  const every = text.match(/^(?:every\s*)?(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/i)
  if (every) {
    const n = Number(every[1])
    const unit = every[2].toLowerCase()
    if (unit.charAt(0) === 'm') return '每 ' + n + ' 分钟'
    if (unit.charAt(0) === 'h') return '每 ' + n + ' 小时'
    return '每 ' + n + ' 天'
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const ms = tsMs(text)
    return '仅一次 · ' + (ms ? util.formatDateTime(ms) : text)
  }

  const parts = text.split(/\s+/)
  if (parts.length !== 5) return text

  const min = parts[0]
  const hour = parts[1]
  const dom = parts[2]
  const mon = parts[3]
  const dow = parts[4]

  if (mon === '*' && dom === '*' && /^\*\/\d+$/.test(min) && hour === '*') {
    return '每 ' + min.slice(2) + ' 分钟'
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return Number(min) === 0 ? '每小时整点' : '每小时第 ' + Number(min) + ' 分钟'
  }
  if (min === '*' && hour === '*') return '每分钟'

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    const hh = pad2(Number(hour))
    const mm = pad2(Number(min))
    if (dow === '*') return '每天 ' + hh + ':' + mm
    if (dow === '1-5') return '工作日 ' + hh + ':' + mm
    if (/^[0-6]$/.test(dow)) return WEEK_LABELS[Number(dow)] + ' ' + hh + ':' + mm
  }
  return text
}

function normalizeJob(raw, index) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const id = String(row.id || row.job_id || row.jobId || ('job' + (index || 0)))
  const expr = expressionOf(row.schedule)
  const display = String(row.schedule_display || row.scheduleDisplay || '')
  const human = humanSchedule(expr)
  let scheduleText = '未设置时间'
  if (!expr) scheduleText = display || human
  else scheduleText = human !== expr ? human : (display || human)

  let enabled = true
  if (row.enabled !== undefined && row.enabled !== null) enabled = !!row.enabled
  else if (String(row.state || '').toLowerCase() === 'paused') enabled = false

  const state = String(row.state || '').toLowerCase()
  const running = !!(row.running || state === 'running')
  const nextRunAt = tsMs(row.next_run_at || row.nextRunAt || row.next_run)
  const lastRunAt = tsMs(row.last_run_at || row.lastRunAt || row.last_run)
  const lastStatus = String(row.last_status || row.lastStatus || '').toLowerCase()
  const lastError = String(row.last_error || row.lastError || '')

  let tone = 'idle'
  let statusText = '等待执行'
  if (running) {
    tone = 'run'
    statusText = '执行中'
  } else if (!enabled) {
    tone = 'off'
    statusText = '已暂停'
  } else if (lastError || /(err|fail)/.test(lastStatus)) {
    tone = 'err'
    statusText = '上次失败'
  } else if (lastRunAt) {
    tone = 'ok'
    statusText = '上次成功'
  }

  return {
    id: id,
    name: String(row.name || row.title || '').trim() || '未命名任务',
    prompt: String(row.prompt || row.description || row.message || '').trim(),
    expr: expr,
    scheduleText: scheduleText,
    enabled: enabled,
    running: running,
    state: state,
    tone: tone,
    statusText: statusText,
    nextRunAt: nextRunAt,
    nextText: nextRunText(nextRunAt),
    lastRunAt: lastRunAt,
    lastText: lastRunAt ? util.formatDateTime(lastRunAt) : '',
    lastStatus: lastStatus,
    lastError: lastError,
    deliver: String(row.deliver || ''),
    workspace: String(row.workspace || row.cwd || row.workdir || ''),
    profile: row.profile || '',
    raw: row
  }
}

function requestError(res, action) {
  if (res.statusCode === 401) {
    return util.makeError('AUTH', '登录已过期，请重新登录', { statusCode: 401 })
  }
  return util.makeError('HTTP', action + '失败（HTTP ' + res.statusCode + '）', { statusCode: res.statusCode })
}

function postJson(endpoint, path, body) {
  return http.authed(endpoint, {
    path: path,
    method: 'POST',
    data: body || {},
    timeout: 20000
  })
}

function list(endpoint, profile) {
  return http.authed(endpoint, { path: withProfile(LIST_PATHS[0], profile), timeout: 15000 })
    .then((res) => {
      if (res.statusCode === 404 || res.statusCode === 405) {
        return http.authed(endpoint, { path: withProfile(LIST_PATHS[1], profile), timeout: 15000 })
      }
      return res
    })
    .then((res) => {
      // 两条路径都不存在时说明该实例没有定时任务模块，按空列表处理即可。
      if (res.statusCode === 404 || res.statusCode === 405) {
        return { jobs: [], unavailable: true, profile: '' }
      }
      if (res.statusCode !== 200) throw requestError(res, '加载定时任务')
      const body = res.data || {}
      const rows = body.jobs || body.cron_jobs || (Array.isArray(body) ? body : [])
      return {
        jobs: (rows || []).map(normalizeJob),
        unavailable: !!body.cron_unavailable,
        profile: body.active_profile || ''
      }
    })
}

function get(endpoint, jobId, profile) {
  return list(endpoint, profile).then((body) => {
    return body.jobs.filter((job) => job.id === jobId)[0] || null
  })
}

function readMutation(res, action) {
  if (res.statusCode < 200 || res.statusCode >= 300) throw requestError(res, action)
  const body = res.data || {}
  if (body.ok === false) {
    throw util.makeError('CRON', body.error || body.message || '服务端拒绝了该操作')
  }
  const candidate = body.job || (body.data && typeof body.data === 'object' ? body.data : null)
  if (candidate && (candidate.id || candidate.job_id)) return normalizeJob(candidate, 0)
  return null
}

function update(endpoint, jobId, patch, profile) {
  const body = Object.assign({ job_id: jobId }, patch || {})
  if (profile) body.profile = profile
  return postJson(endpoint, '/api/crons/update', body)
    .then((res) => {
      if (res.statusCode === 404 || res.statusCode === 405) {
        return postJson(endpoint, '/api/cron/jobs/' + encodeURIComponent(jobId), body)
      }
      return res
    })
    .then((res) => readMutation(res, '保存定时任务'))
}

function setEnabled(endpoint, job, enabled, profile) {
  const id = job && job.id
  if (!id) return Promise.reject(util.makeError('CRON', '任务信息缺失，请刷新后重试'))
  const next = !!enabled
  return update(endpoint, id, { enabled: next }, profile).catch((err) => {
    const missing = err && (err.statusCode === 404 || err.statusCode === 405)
    if (!missing) throw err
    const body = { job_id: id }
    if (profile) body.profile = profile
    return postJson(endpoint, next ? '/api/crons/resume' : '/api/crons/pause', body)
      .then((res) => readMutation(res, next ? '启用定时任务' : '暂停定时任务'))
  })
}

// 把已有表达式拆成表单字段；无法识别的表达式落到「自定义」。
function parseExpression(expr) {
  const text = String(expr || '').trim()
  const out = {
    mode: 'custom',
    hour: 9,
    minute: 0,
    weekday: 1,
    intervalValue: 2,
    intervalUnit: 'h',
    expr: text
  }
  if (!text) {
    out.mode = 'daily'
    return out
  }
  const every = text.match(/^(?:every\s*)?(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/i)
  if (every) {
    const unit = every[2].toLowerCase().charAt(0)
    out.mode = 'interval'
    out.intervalValue = Number(every[1]) || 1
    out.intervalUnit = unit === 'm' ? 'm' : (unit === 'd' ? 'd' : 'h')
    return out
  }
  const parts = text.split(/\s+/)
  if (parts.length !== 5) return out
  const min = parts[0]
  const hour = parts[1]
  const dom = parts[2]
  const mon = parts[3]
  const dow = parts[4]
  if (!/^\d+$/.test(min) || dom !== '*' || mon !== '*') return out
  if (hour === '*') {
    out.mode = 'hourly'
    out.minute = Number(min) || 0
    return out
  }
  if (!/^\d+$/.test(hour)) return out
  out.minute = clamp(Number(min), 0, 59)
  out.hour = clamp(Number(hour), 0, 23)
  if (dow === '*') {
    out.mode = 'daily'
    return out
  }
  if (/^[0-6]$/.test(dow)) {
    out.mode = 'weekly'
    out.weekday = Number(dow)
    return out
  }
  return out
}

function buildExpression(cfg) {
  const c = cfg || {}
  const mode = c.mode || 'daily'
  const minute = clamp(Number(c.minute), 0, 59)
  const hour = clamp(Number(c.hour), 0, 23)
  if (mode === 'daily') return minute + ' ' + hour + ' * * *'
  if (mode === 'weekly') return minute + ' ' + hour + ' * * ' + clamp(Number(c.weekday), 0, 6)
  if (mode === 'hourly') return minute + ' * * * *'
  if (mode === 'interval') {
    const value = clamp(Number(c.intervalValue), 1, 999)
    const unit = ['m', 'h', 'd'].indexOf(c.intervalUnit) >= 0 ? c.intervalUnit : 'h'
    return 'every ' + value + unit
  }
  return String(c.expr || '').trim()
}

module.exports = {
  WEEK_LABELS,
  DAY_MS,
  pad2,
  tsMs,
  nextRunText,
  expressionOf,
  humanSchedule,
  normalizeJob,
  list,
  get,
  update,
  setEnabled,
  parseExpression,
  buildExpression
}
