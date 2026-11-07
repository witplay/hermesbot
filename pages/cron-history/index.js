const store = require('../../utils/store')
const cron = require('../../utils/cron')
const sessionops = require('../../utils/sessionops')
const workspaces = require('../../utils/workspaces')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

// 会话列表一次最多取 100 条，历史页按这个窗口向后扫描，过滤出当前任务的运行会话。
const SCAN_LIMIT = 100
// 一屏至少铺满 20 条，不够就继续向后扫描。
const MIN_PAGE = 20
const MAX_SCAN = 4

function toRow(item) {
  return {
    id: item.id,
    cwd: item.cwd,
    title: item.title,
    preview: item.preview,
    dateText: item.timeFull,
    ok: item.ok,
    statusText: item.statusText,
    wsName: item.wsName
  }
}

Page({
  data: {
    jobId: '',
    jobName: '',
    scheduleText: '',
    items: [],
    hasMore: true,
    loading: true,
    loadingMore: false,
    refreshing: false,
    error: '',
    moreError: '',
    theme: '',
    themeVars: ''
  },

  onLoad(options) {
    theme.apply(this)
    this.destroyed = false
    this.endpoint = null
    this.job = null
    this.seen = {}
    this.sessionOffset = 0
    this.loadingPage = false
    this.hasMore = true
    this.seq = 0

    this.jobId = util.safeDecode(options.id || '')
    this.profile = util.safeDecode(options.profile || '')
    const name = util.safeDecode(options.name || '')
    this.setData({ jobId: this.jobId, jobName: name })
    wx.setNavigationBarTitle({ title: name || '历史记录' })

    const epId = util.safeDecode(options.ep || '') || store.getActiveId()
    const ep = epId ? store.get(epId) : null
    if (!ep || !this.jobId) {
      this.setData({
        loading: false,
        error: ep ? '任务参数缺失，请返回列表重试' : '没有可用的站点，请返回重试'
      })
      return
    }
    this.endpoint = ep
    this.loadJob().then(() => {
      if (!this.destroyed) this.loadPage(true)
    })
  },

  onShow() {
    theme.apply(this)
  },

  onUnload() {
    this.destroyed = true
    this.seq += 1
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

  loadJob() {
    // 任务名与提示词用于把会话归到当前任务，失败时仍可用列表页带来的名称匹配。
    this.jobPromise = cron.get(this.endpoint, this.jobId, this.profile)
      .then((job) => {
        if (this.destroyed || !job) return null
        this.job = job
        const name = this.data.jobName || job.name
        this.setData({ jobName: name, scheduleText: job.scheduleText })
        wx.setNavigationBarTitle({ title: name || '历史记录' })
        return job
      })
      .catch(() => null)
    return this.jobPromise
  },

  belongsToJob(item) {
    if (item.jobId && String(item.jobId) === String(this.jobId)) return true
    const name = String(this.data.jobName || (this.job && this.job.name) || '').toLowerCase().trim()
    if (name && String(item.title || '').toLowerCase().indexOf(name) >= 0) return true
    const workspace = this.job && this.job.workspace
    if (workspace && item.cwd && String(item.cwd) === String(workspace)) return true
    const prompt = String((this.job && this.job.prompt) || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 24)
    return !!prompt && String(item.preview || '').toLowerCase().indexOf(prompt) >= 0
  },

  collect(sessions) {
    const rows = []
    sessions.forEach((row) => {
      const item = workspaces.session(row)
      if (item.channel !== 'cron') return
      if (this.seen[item.id]) return
      if (!this.belongsToJob(item)) return
      this.seen[item.id] = 1
      rows.push(toRow(item))
    })
    return rows
  },

  // 从最近会话开始向后扫描，直到凑满一屏或会话列表见底。
  scanPages(left, acc) {
    if (left <= 0) return Promise.resolve({ rows: acc, hasMore: true })
    const offset = this.sessionOffset
    return sessionops.list(this.endpoint, this.profile, SCAN_LIMIT, offset).then((body) => {
      const sessions = body.sessions || []
      this.sessionOffset = offset + sessions.length
      const merged = acc.concat(this.collect(sessions))
      const pageFull = sessions.length >= SCAN_LIMIT
      if (!pageFull) return { rows: merged, hasMore: false }
      if (merged.length >= MIN_PAGE) return { rows: merged, hasMore: true }
      return this.scanPages(left - 1, merged)
    })
  },

  loadPage(reset) {
    if (!this.endpoint || this.destroyed || this.loadingPage) return Promise.resolve()
    this.loadingPage = true
    if (reset) {
      this.seen = {}
      this.sessionOffset = 0
      this.setData({ loading: true, error: '', moreError: '', items: [], hasMore: true })
    } else {
      this.setData({ loadingMore: true, moreError: '' })
    }

    const seq = (this.seq || 0) + 1
    this.seq = seq
    return this.scanPages(MAX_SCAN, []).then((result) => {
      if (this.destroyed || seq !== this.seq) return
      this.loadingPage = false
      const rows = result.rows || []
      // 没有新增记录说明服务端忽略了 offset，直接停止继续加载。
      const hasMore = rows.length > 0 && !!result.hasMore
      this.applyRows(rows, hasMore, reset)
    }).catch((err) => {
      if (this.destroyed || seq !== this.seq) return
      this.loadingPage = false
      if (this.isAuthError(err)) {
        this.setData({ loading: false, loadingMore: false, refreshing: false })
        this.onAuthExpired()
        return
      }
      if (reset && this.data.items.length) {
        this.setData({ loading: false, refreshing: false })
        wx.showToast({ title: '刷新失败：' + util.errorText(err), icon: 'none' })
        return
      }
      if (reset) {
        this.setData({ loading: false, refreshing: false, error: util.errorText(err) })
        return
      }
      this.setData({ loadingMore: false, moreError: '加载更多失败，点击重试' })
    })
  },

  applyRows(rows, hasMore, reset) {
    this.hasMore = hasMore
    const base = reset ? 0 : this.data.items.length
    const patch = {
      loading: false,
      loadingMore: false,
      refreshing: false,
      hasMore: hasMore
    }
    if (reset) {
      patch.items = rows
    } else {
      rows.forEach((row, index) => {
        patch['items[' + (base + index) + ']'] = row
      })
    }
    this.setData(patch)
  },

  onLoadMore() {
    if (this.data.loading || this.data.loadingMore || this.data.error) return
    if (!this.hasMore) return
    this.loadPage(false)
  },

  onMoreRetry() {
    if (this.data.loadingMore) return
    this.loadPage(false)
  },

  onRefresh() {
    if (this.loadingPage) {
      this.setData({ refreshing: false })
      return
    }
    this.setData({ refreshing: true })
    this.loadPage(true)
  },

  onRetry() {
    if (this.data.loading) return
    this.loadPage(true)
  },

  onOpen(e) {
    const ds = e.detail || {}
    if (!ds.id || !this.endpoint) return
    let url = '/pages/chat/index?id=' + encodeURIComponent(this.endpoint.id) +
      '&sid=' + encodeURIComponent(ds.id)
    if (ds.cwd) url += '&cwd=' + encodeURIComponent(ds.cwd)
    if (this.profile) url += '&profile=' + encodeURIComponent(this.profile)
    if (ds.title) url += '&title=' + encodeURIComponent(ds.title)
    wx.navigateTo({ url: url })
  }
})
