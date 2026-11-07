const store = require('../../utils/store')
const cron = require('../../utils/cron')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

const MODES = [
  { id: 'daily', label: '每天' },
  { id: 'weekly', label: '每周' },
  { id: 'hourly', label: '每小时' },
  { id: 'interval', label: '间隔' },
  { id: 'custom', label: '自定义' }
]

const UNITS = [
  { id: 'm', label: '分钟' },
  { id: 'h', label: '小时' },
  { id: 'd', label: '天' }
]

const WEEKDAYS = cron.WEEK_LABELS.map((label, index) => ({
  id: index,
  label: label.slice(1),
  full: label
}))

function minuteLabels() {
  const out = []
  for (let i = 0; i < 60; i++) out.push('第 ' + i + ' 分钟')
  return out
}

Page({
  data: {
    loading: true,
    saving: false,
    busy: false,
    error: '',
    jobId: '',
    profile: '',
    name: '',
    prompt: '',
    enabled: true,
    mode: 'daily',
    modes: MODES,
    units: UNITS,
    weekdays: WEEKDAYS,
    time: '09:00',
    weekday: 1,
    weekdayLabel: '周一',
    minute: 0,
    minuteIndex: 0,
    minuteLabels: [],
    intervalValue: 2,
    intervalUnit: 'h',
    cronExpr: '',
    scheduleText: '',
    nextText: '',
    statusText: '',
    lastText: '',
    theme: '',
    themeVars: ''
  },

  onLoad(options) {
    theme.apply(this)
    this.destroyed = false
    wx.setNavigationBarTitle({ title: '定时任务' })
    const epId = util.safeDecode(options.ep || '') || store.getActiveId()
    const ep = epId ? store.get(epId) : null
    if (!ep) {
      this.setData({ loading: false, error: '没有可用的站点，请先返回选择站点' })
      return
    }
    this.endpoint = ep
    this.profile = util.safeDecode(options.profile || '')
    this.jobId = util.safeDecode(options.id || '')
    this.setData({
      jobId: this.jobId,
      profile: this.profile,
      minuteLabels: minuteLabels()
    })
    if (!this.jobId) {
      this.setData({ loading: false, error: '任务参数缺失，请返回列表重试' })
      return
    }
    this.load()
  },

  onShow() {
    theme.apply(this)
  },

  onUnload() {
    this.destroyed = true
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  },

  load() {
    this.setData({ loading: true, error: '' })
    cron.get(this.endpoint, this.jobId, this.profile)
      .then((job) => {
        if (this.destroyed) return
        if (!job) throw util.makeError('CRON', '任务不存在或已被删除')
        this.applyJob(job)
      })
      .catch((err) => {
        if (this.destroyed) return
        if (this.isAuthError(err)) {
          this.onAuthExpired()
          return
        }
        this.setData({ loading: false, error: util.errorText(err) })
      })
  },

  applyJob(job) {
    const patch = {
      loading: false,
      name: job.name,
      prompt: job.prompt,
      enabled: job.enabled,
      scheduleText: job.scheduleText || this.data.scheduleText,
      nextText: job.nextText,
      statusText: job.statusText,
      lastText: job.lastText
    }
    // 服务端只回传部分字段时保留表单里已有的时间设置，避免被默认值覆盖。
    if (job.expr) {
      const parsed = cron.parseExpression(job.expr)
      const weekday = parsed.mode === 'weekly' ? parsed.weekday : this.data.weekday
      patch.mode = parsed.mode
      patch.time = cron.pad2(parsed.hour) + ':' + cron.pad2(parsed.minute)
      patch.weekday = weekday
      patch.weekdayLabel = (WEEKDAYS[weekday] || WEEKDAYS[1]).full
      patch.minute = parsed.minute
      patch.minuteIndex = parsed.minute
      patch.intervalValue = parsed.intervalValue
      patch.intervalUnit = parsed.intervalUnit
      patch.cronExpr = parsed.expr || job.expr
    }
    this.setData(patch)
  },

  isAuthError(err) {
    return !!(err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED'))
  },

  onAuthExpired() {
    if (this.prompted) return
    this.prompted = true
    wx.showModal({
      title: '登录已过期',
      content: '需要重新登录该站点',
      showCancel: false,
      success: () => {
        if (this.endpoint) {
          wx.redirectTo({ url: '/pages/endpoint-form/index?id=' + this.endpoint.id + '&relogin=1&auto=1' })
        } else {
          wx.navigateBack()
        }
      }
    })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    const patch = {}
    patch[field] = e.detail.value
    this.setData(patch)
  },

  onMode(e) {
    const id = e.currentTarget.dataset.id
    if (!id || id === this.data.mode) return
    this.setData({ mode: id }, () => this.syncSchedule())
  },

  onTime(e) {
    this.setData({ time: e.detail.value || '09:00' }, () => this.syncSchedule())
  },

  onWeekday(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (isNaN(id)) return
    this.setData({
      weekday: id,
      weekdayLabel: (WEEKDAYS[id] || WEEKDAYS[1]).full
    }, () => this.syncSchedule())
  },

  onMinute(e) {
    const index = Number(e.detail.value) || 0
    this.setData({ minute: index, minuteIndex: index }, () => this.syncSchedule())
  },

  onIntervalValue(e) {
    const value = e.detail.value
    this.setData({ intervalValue: value }, () => this.syncSchedule())
  },

  onIntervalUnit(e) {
    const id = e.currentTarget.dataset.id
    if (!id || id === this.data.intervalUnit) return
    this.setData({ intervalUnit: id }, () => this.syncSchedule())
  },

  onCronExpr(e) {
    this.setData({ cronExpr: e.detail.value || '' }, () => this.syncSchedule())
  },

  timeParts() {
    const parts = String(this.data.time || '09:00').split(':')
    return {
      hour: Number(parts[0]) || 0,
      minute: Number(parts[1]) || 0
    }
  },

  currentExpression() {
    const parts = this.timeParts()
    return cron.buildExpression({
      mode: this.data.mode,
      hour: parts.hour,
      minute: this.data.mode === 'hourly' ? this.data.minute : parts.minute,
      weekday: this.data.weekday,
      intervalValue: this.data.intervalValue,
      intervalUnit: this.data.intervalUnit,
      expr: this.data.cronExpr
    })
  },

  syncSchedule() {
    // 修改时间后旧的「下次执行」已经失效，等保存后由服务端重新计算。
    this.setData({
      scheduleText: cron.humanSchedule(this.currentExpression()),
      nextText: ''
    })
  },

  validExpression(expr) {
    const text = String(expr || '').trim()
    if (!text) return false
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true
    if (/^(every\s*)?\d+\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/i.test(text)) return true
    return text.split(/\s+/).length === 5
  },

  onToggleEnabled() {
    if (this.data.busy || this.data.loading) return
    const next = !this.data.enabled
    this.setData({ enabled: next, busy: true })
    cron.setEnabled(this.endpoint, { id: this.data.jobId }, next, this.profile)
      .then((job) => {
        if (this.destroyed) return
        const patch = { busy: false }
        if (job) {
          patch.enabled = job.enabled
          patch.statusText = job.statusText
          patch.nextText = job.nextText
          patch.lastText = job.lastText
        }
        this.setData(patch)
        wx.showToast({ title: next ? '已启用' : '已暂停', icon: 'none' })
      })
      .catch((err) => {
        if (this.destroyed) return
        this.setData({ enabled: !next, busy: false })
        if (this.isAuthError(err)) {
          this.onAuthExpired()
          return
        }
        wx.showToast({ title: '操作失败：' + util.errorText(err), icon: 'none' })
      })
  },

  onSave() {
    if (this.data.saving || this.data.loading) return
    const name = String(this.data.name || '').trim()
    const prompt = String(this.data.prompt || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写任务标题', icon: 'none' })
      return
    }
    if (!prompt) {
      wx.showToast({ title: '请填写任务描述', icon: 'none' })
      return
    }
    const schedule = this.currentExpression()
    if (!this.validExpression(schedule)) {
      wx.showToast({ title: '执行时间格式不正确', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    cron.update(this.endpoint, this.data.jobId, {
      name: name,
      prompt: prompt,
      schedule: schedule
    }, this.profile)
      .then((job) => {
        if (this.destroyed) return
        this.setData({ saving: false })
        if (job) this.applyJob(job)
        wx.showToast({ title: '已保存', icon: 'none' })
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null
          if (!this.destroyed) wx.navigateBack()
        }, 500)
      })
      .catch((err) => {
        if (this.destroyed) return
        this.setData({ saving: false })
        if (this.isAuthError(err)) {
          this.onAuthExpired()
          return
        }
        wx.showToast({ title: '保存失败：' + util.errorText(err), icon: 'none' })
      })
  },

  onRetry() {
    if (!this.jobId || !this.endpoint) {
      wx.navigateBack()
      return
    }
    if (this.data.loading) return
    this.load()
  }
})
