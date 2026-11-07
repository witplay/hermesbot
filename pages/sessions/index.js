const store = require('../../utils/store')
const auth = require('../../utils/auth')
const http = require('../../utils/http')
const util = require('../../utils/util')
const theme = require('../../utils/theme')
const sessionops = require('../../utils/sessionops')
const workspaces = require('../../utils/workspaces')
const drafts = require('../../utils/drafts')
const last = require('../../utils/last')
const files = require('../../utils/files')
const models = require('../../utils/models')
const cron = require('../../utils/cron')

const RECENT_LIMIT = 5
const CRON_RECENT_LIMIT = 5

// 页面 URL 是用 encodeURIComponent 拼的，框架把 query 原样交回来，所以这里解码一次；
// 否则含中文的工作区路径与 profile 会以 "%E4%B8%AD..." 的形式显示。
function urlText(options, key) {
  if (!options || options[key] == null) return ''
  const raw = String(options[key])
  if (raw.indexOf('%') < 0) return raw
  return util.safeDecode(raw)
}

function screenMetrics() {
  let win = { statusBarHeight: 20, windowWidth: 375 }
  try { win = wx.getWindowInfo() } catch (e) {
    try { win = wx.getSystemInfoSync() } catch (e2) { /* ignore */ }
  }
  let rect = null
  try { rect = wx.getMenuButtonBoundingClientRect() } catch (e) { /* ignore */ }
  const statusBarHeight = win.statusBarHeight || 20
  let navRowHeight = 46
  let capsulePad = 96
  if (rect && rect.top && rect.height) {
    navRowHeight = Math.max(44, (rect.top - statusBarHeight) * 2 + rect.height)
    capsulePad = Math.max(12, (win.windowWidth || 375) - rect.left + 8)
  }
  return { statusBarHeight: statusBarHeight, navRowHeight: navRowHeight, capsulePad: capsulePad }
}

Page({
  data: {
    endpoint: null,
    endpointLabel: '',
    endpointUrl: '',
    profile: '',
    profileLabel: 'default',
    profiles: [],
    tabs: [],
    tab: 'all',
    query: '',
    groups: [],
    recentList: [],
    allCount: 0,
    shownCount: 0,
    hasAny: false,
    cronJobs: [],
    cronList: [],
    cronLoaded: false,
    cronLoading: false,
    cronError: '',
    cronUnavailable: false,
    cronRecent: [],
    cronBusyId: '',
    loading: true,
    refreshing: false,
    pullRefresh: false,
    error: '',
    metrics: {},
    statusBarHeight: 20,
    navRowHeight: 46,
    capsulePad: 96,
    recentWs: [],
    defaultCwd: '',
    defaultCwdShort: '',
    showPicker: false,
    nsModel: '',
    nsModelShort: '',
    nsProvider: '',
    nsProviderName: '',
    nsModelLoading: false,
    nsModelError: '',
    nsProviders: [],
    nsModelOpen: false,
    nsPickProvider: '',
    nsSearch: '',
    nsList: [],
    nsListMore: false,
    nsReasoningLevels: models.LEVELS,
    nsReasoning: '',
    nsReasoningLabel: '默认',
    nsReasoningAvailable: true,
    fsShow: false,
    fsRoot: '',
    showTheme: false,
    theme: '',
    themeName: '',
    themeOptions: [],
    themeVars: ''
  },

  onLoad(options) {
    theme.apply(this)
    const id = urlText(options, 'id') || store.getActiveId()
    const ep = id ? store.get(id) : null
    if (!ep) {
      wx.showModal({
        title: '没有站点',
        content: '请先添加一个 Hermes 站点',
        showCancel: false,
        success() { wx.reLaunch({ url: '/pages/endpoints/index' }) }
      })
      return
    }
    this.endpoint = ep
    this.allItems = []
    this.loadSeq = 0
    this.wsOpen = {}
    this.wsSearchOpen = {}
    store.setActiveId(ep.id)
    store.touch(ep.id)
    const metrics = screenMetrics()
    const initialProfile = urlText(options, 'profile') || store.getSettings(ep.id).profile || ''
    this.setData(Object.assign({}, metrics, {
      endpoint: ep,
      endpointLabel: ep.label,
      endpointUrl: ep.baseUrl,
      profile: initialProfile,
      profileLabel: initialProfile || 'default',
      metrics: metrics
    }))
    this.buildTabs()
  },

  onShow() {
    this.destroyed = false
    theme.apply(this)
    if (!this.endpoint) return
    this.loadProfiles().then(() => this.load())
    this.loadDefaultCwd()
  },

  noop() {},

  onPullDownRefresh() {
    this.onRefresh()
    wx.stopPullDownRefresh()
  },

  loadProfiles() {
    if (!this.endpoint) return Promise.resolve(this.data.profile)
    if (this.profilesPromise) return this.profilesPromise
    const endpointId = this.endpoint.id
    this.profilesPromise = http.authed(this.endpoint, { path: '/api/profiles', timeout: 12000 })
      .then((res) => {
        if (!this.endpoint || this.endpoint.id !== endpointId) return this.data.profile
        if (res.statusCode === 401) {
          // 401 不是 rejected promise，不主动清缓存的话恢复登录后也不会重拉。
          this.profilesPromise = null
          this.onAuthExpired()
          return this.data.profile
        }
        if (res.statusCode !== 200) return this.data.profile
        const list = (res.data && res.data.profiles) || []
        const names = list.map((p) => p.name).filter(Boolean)
        const def = (list.find((p) => p.is_default) || list[0] || {}).name || 'default'
        let profile = this.data.profile
        if (!profile || names.indexOf(profile) < 0) profile = def
        this.setData({ profiles: names, profile: profile, profileLabel: profile || 'default' })
        store.setSettings(this.endpoint.id, { profile: profile })
        return profile
      })
      .catch((err) => {
        if (this.endpoint && this.endpoint.id === endpointId) {
          this.profilesPromise = null
          // http.authed 在刷新失败时会抛 AUTH_REQUIRED，此时同样是登录过期。
          if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
            this.onAuthExpired()
          }
        }
        return this.data.profile
      })
    return this.profilesPromise
  },

  loadDefaultCwd() {
    if (!this.endpoint || this.defaultCwdTried) return
    this.defaultCwdTried = true
    const endpointId = this.endpoint.id
    files.defaultCwd(this.endpoint, this.data.profile)
      .then((body) => {
        if (!this.endpoint || this.endpoint.id !== endpointId || !body || !body.cwd) return
        this.defaultCwd = body.cwd
        this.setData({
          defaultCwd: body.cwd,
          defaultCwdShort: workspaces.shortPath(body.cwd)
        })
      })
      .catch(() => { /* picker falls back to server default */ })
  },

  loadNewModel(refresh) {
    if (!this.endpoint) return Promise.resolve(null)
    const endpointId = this.endpoint.id
    const profile = this.data.profile || ''
    const cacheKey = endpointId + '::' + profile
    if (!refresh && this.nsModelBody && this.nsModelCacheKey === cacheKey) {
      return Promise.resolve(this.nsModelBody)
    }
    if (this.nsLoading && !refresh) return this.nsLoading
    const seq = (this.nsSeq || 0) + 1
    this.nsSeq = seq
    const query = []
    if (profile) query.push('profile=' + encodeURIComponent(profile))
    if (refresh) query.push('refresh=1')
    this.setData({ nsModelLoading: true, nsModelError: '' })
    this.nsLoading = http.authed(this.endpoint, {
      path: '/api/model/options' + (query.length ? '?' + query.join('&') : ''),
      timeout: 45000
    })
      .then((res) => {
        if (seq !== this.nsSeq || !this.endpoint || this.endpoint.id !== endpointId) return null
        if (res.statusCode === 401) {
          this.setData({ nsModelLoading: false })
          this.onAuthExpired()
          return null
        }
        if (res.statusCode !== 200) {
          throw util.makeError('HTTP', '加载模型失败（HTTP ' + res.statusCode + '）')
        }
        return res.data || {}
      })
      .then((body) => {
        if (!body || seq !== this.nsSeq) return null
        this.nsModelBody = body
        this.nsModelCacheKey = cacheKey
        this.applyNewModel(body)
        return body
      })
      .catch((err) => {
        if (seq === this.nsSeq && this.endpoint && this.endpoint.id === endpointId) {
          if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
            this.setData({ nsModelLoading: false })
            this.onAuthExpired()
          } else {
            this.setData({ nsModelLoading: false, nsModelError: util.errorText(err) })
          }
        }
        return null
      })
      .then((body) => {
        // An older request must not clear the promise of a newer one after the
        // user has switched profiles or sites.
        if (seq === this.nsSeq) this.nsLoading = null
        return body
      })
    return this.nsLoading
  },

  applyNewModel(body) {
    const providers = models.providers(body)
    let model = String(body.model || '')
    let provider = providers.filter((p) => p.current)[0] ||
      providers.filter((p) => p.slug === body.provider)[0] || null
    if (model && (!provider || provider.models.indexOf(model) < 0)) {
      provider = providers.filter((p) => p.models.indexOf(model) >= 0)[0] || provider
    }
    let selectedProvider = this.data.nsProvider
    if (!providers.some((p) => p.slug === selectedProvider)) {
      selectedProvider = provider ? provider.slug : (providers[0] ? providers[0].slug : '')
    }
    const activeProvider = providers.filter((p) => p.slug === selectedProvider)[0] || provider
    let selectedModel = this.data.nsModel
    if (!selectedModel || !providers.some((p) => p.models.indexOf(selectedModel) >= 0)) {
      selectedModel = model
    }
    const available = !activeProvider || models.reasoningSupported(activeProvider, selectedModel)
    const patch = {
      nsProviders: providers,
      nsProvider: selectedProvider,
      nsProviderName: activeProvider ? activeProvider.name : '',
      nsModel: selectedModel,
      nsModelShort: models.shortModel(selectedModel),
      nsModelLoading: false,
      nsModelError: '',
      nsPickProvider: selectedProvider,
      nsReasoningAvailable: available
    }
    if (!available) {
      patch.nsReasoning = ''
      patch.nsReasoningLabel = '默认'
    }
    this.setData(patch, () => this.buildNsList())
  },

  buildNsList() {
    const providers = this.data.nsProviders || []
    const query = String(this.data.nsSearch || '').trim().toLowerCase()
    const provider = providers.filter((p) => p.slug === this.data.nsPickProvider)[0] ||
      models.currentProvider(providers, this.data.nsProvider)
    const rows = []
    const add = (prov, model) => {
      if (query && model.toLowerCase().indexOf(query) < 0) return
      const label = models.shortModel(model)
      const cap = models.capability(prov, model)
      rows.push({
        key: prov.slug + '::' + model,
        model: model,
        label: label,
        sub: query ? prov.name : (model === label ? '' : model),
        slug: prov.slug,
        reasoning: !!(cap && cap.reasoning),
        fast: !!(cap && cap.fast),
        current: prov.slug === this.data.nsProvider && model === this.data.nsModel
      })
    }
    if (query) {
      providers.forEach((prov) => prov.models.forEach((model) => add(prov, model)))
    } else if (provider) {
      provider.models.forEach((model) => add(provider, model))
    }
    this.setData({ nsList: rows.slice(0, 200), nsListMore: rows.length > 200 })
  },

  onNsModelOpen() {
    this.setData({
      nsModelOpen: true,
      nsSearch: '',
      nsPickProvider: this.data.nsProvider
    }, () => this.buildNsList())
    this.loadNewModel(false)
  },

  onNsModelClose() {
    this.setData({ nsModelOpen: false })
  },

  onNsRefresh() {
    this.loadNewModel(true)
  },

  onNsProvider(e) {
    const slug = e.currentTarget.dataset.slug
    if (!slug || slug === this.data.nsPickProvider) return
    this.setData({ nsPickProvider: slug, nsSearch: '' }, () => this.buildNsList())
  },

  onNsSearch(e) {
    this.setData({ nsSearch: e.detail.value || '' }, () => this.buildNsList())
  },

  onNsSearchClear() {
    this.setData({ nsSearch: '' }, () => this.buildNsList())
  },

  onNsPick(e) {
    const ds = e.currentTarget.dataset
    const model = String(ds.model || '')
    const slug = String(ds.slug || '')
    if (!model || !slug) return
    if (ds.current) {
      this.onNsModelClose()
      return
    }
    const provider = (this.data.nsProviders || []).filter((p) => p.slug === slug)[0] || null
    const available = !provider || models.reasoningSupported(provider, model)
    const patch = {
      nsModel: model,
      nsModelShort: models.shortModel(model),
      nsProvider: slug,
      nsProviderName: provider ? provider.name : slug,
      nsModelOpen: false,
      nsPickProvider: slug,
      nsReasoningAvailable: available
    }
    if (!available) {
      patch.nsReasoning = ''
      patch.nsReasoningLabel = '默认'
    }
    this.setData(patch, () => this.buildNsList())
  },

  onNsReasoning(e) {
    if (!this.data.nsReasoningAvailable) return
    const level = String(e.currentTarget.dataset.id || '').toLowerCase()
    if (!level) return
    this.setData({
      nsReasoning: level,
      nsReasoningLabel: models.levelLabel(level) || level
    })
  },

  newSessionOptions() {
    const options = {}
    if (this.data.nsModel && this.data.nsProvider) {
      options.model = this.data.nsModel
      options.provider = this.data.nsProvider
    }
    if (this.data.nsReasoning) options.reasoning = this.data.nsReasoning
    return options
  },

  load() {
    if (!this.endpoint) return Promise.resolve()
    const endpointId = this.endpoint.id
    const seq = (this.loadSeq || 0) + 1
    this.loadSeq = seq
    this.setData({ error: '', loading: !this.allItems.length, refreshing: true })
    // 与会话列表并行拉取，避免服务端缺少会话接口时定时任务一直不加载。
    this.loadCron()

    return sessionops.list(this.endpoint, this.data.profile, 100)
      .then((body) => {
        if (!this.endpoint || this.endpoint.id !== endpointId || seq !== this.loadSeq) return
        // 列表成功返回说明令牌已恢复可用，下次过期允许再自动续期一次。
        this.authRecovered = false
        // Read the draft map once instead of issuing one storage read per row.
        const draftMap = drafts.snapshot()
        const rows = (body.sessions || []).map((row) => {
          const item = workspaces.session(row)
          item.draft = drafts.has(drafts.key(endpointId, item.id, item.cwd), draftMap)
          return item
        })
        this.allItems = rows
        this.total = body.total || rows.length
        this.recentWs = workspaces.recentWorkspaces(rows).slice(0, 8)
        this.buildTabs()
        this.applyFilters()
        this.setData({ loading: false, refreshing: false, recentWs: this.recentWs })
      })
      .catch((err) => {
        if (!this.endpoint || this.endpoint.id !== endpointId || seq !== this.loadSeq) return
        this.setData({ loading: false, refreshing: false, error: util.errorText(err) })
        if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          this.onAuthExpired()
        }
      })
  },

  buildTabs() {
    const items = this.allItems || []
    let session = 0
    let feishu = 0
    let other = 0
    items.forEach((item) => {
      if (item.channel === 'feishu') feishu += 1
      else if (item.channel === 'session') session += 1
      else if (item.channel !== 'cron') other += 1
    })
    this.setData({
      tabs: [
        { id: 'all', label: '全部', count: items.length },
        { id: 'session', label: '会话', count: session },
        { id: 'feishu', label: '飞书', count: feishu },
        { id: 'other', label: '其他', count: other },
        { id: 'cron', label: '定时任务', count: (this.data.cronJobs || []).length }
      ]
    })
  },

  cronRecentFromSessions(q) {
    const rows = (this.allItems || []).filter((item) => item.channel === 'cron')
    const matched = q
      ? rows.filter((item) => [item.title, item.preview, item.cwd, item.wsName].join(' ').toLowerCase().indexOf(q) >= 0)
      : rows
    return matched
      .slice()
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, CRON_RECENT_LIMIT)
      .map((item) => Object.assign({}, item, { dateText: item.timeFull }))
  },

  applyFilters() {
    const tab = this.data.tab
    const q = (this.data.query || '').trim().toLowerCase()
    const cronJobs = this.data.cronJobs || []
    const cronRecent = this.cronRecentFromSessions(q)
    const cronList = cronJobs.filter((job) => {
      if (!q) return true
      return [job.name, job.prompt, job.scheduleText, job.statusText].join(' ').toLowerCase().indexOf(q) >= 0
    })

    // 定时任务标签页是独立面板（最近消息 + 任务列表），不再渲染会话分组。
    if (tab === 'cron') {
      this.setData({
        groups: [],
        recentList: [],
        cronList: cronList,
        cronRecent: cronRecent,
        shownCount: cronList.length,
        allCount: cronJobs.length,
        hasAny: (this.allItems || []).length > 0
      })
      return
    }

    const filtered = (this.allItems || []).filter((item) => {
      if (item.hasContent === false) return false
      if (tab === 'session' && item.channel !== 'session') return false
      if (tab === 'feishu' && item.channel !== 'feishu') return false
      // 定时任务已有独立标签页，不再混在「其他」里。
      if (tab === 'other' && (item.channel === 'session' || item.channel === 'feishu' || item.channel === 'cron')) return false
      if (!q) return true
      const haystack = [item.title, item.preview, item.wsName, item.cwd, item.channelLabel].join(' ').toLowerCase()
      return haystack.indexOf(q) >= 0
    })
    // 定时任务消息已归入「定时任务」标签页，最近会话只保留真实对话会话。
    const recentList = filtered
      .filter((item) => item.channel !== 'cron')
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, RECENT_LIMIT)
    const open = this.wsOpen || {}
    const searchOpen = this.wsSearchOpen || {}
    const groups = workspaces.group(filtered).map((group) => {
      group.displayPath = group.short || group.cwd || '服务器默认目录'
      group.expanded = q ? searchOpen[group.key] !== false : !!open[group.key]
      return group
    })
    this.setData({
      groups: groups,
      recentList: recentList,
      cronList: cronList,
      cronRecent: cronRecent,
      shownCount: filtered.length,
      allCount: (this.allItems || []).length,
      hasAny: (this.allItems || []).length > 0
    })
  },

  onToggleGroup(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const group = (this.data.groups || []).filter((g) => g.key === key)[0]
    if (!group) return
    const expanded = !group.expanded
    if ((this.data.query || '').trim()) {
      this.wsSearchOpen = this.wsSearchOpen || {}
      this.wsSearchOpen[key] = expanded
    } else {
      this.wsOpen = this.wsOpen || {}
      this.wsOpen[key] = expanded
    }
    this.applyFilters()
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.id
    if (!tab || tab === this.data.tab) return
    this.setData({ tab: tab })
    this.applyFilters()
    if (tab === 'cron' && !this.data.cronLoaded) this.loadCron()
  },

  onSearch(e) {
    const query = e.detail.value || ''
    if (query !== this.data.query) this.wsSearchOpen = {}
    this.setData({ query: query })
    this.applyFilters()
  },

  onSearchClear() {
    this.wsSearchOpen = {}
    this.setData({ query: '' })
    this.applyFilters()
  },

  onResetFilters() {
    this.wsSearchOpen = {}
    this.setData({ tab: 'all', query: '' })
    this.applyFilters()
  },

  onRefresh() {
    if (this.data.refreshing) {
      this.setData({ pullRefresh: false })
      return
    }
    this.setData({ pullRefresh: true })
    this.loadProfiles()
      .then(() => this.load())
      .then(() => this.loadCron(true))
      .then(() => this.setData({ pullRefresh: false }), () => this.setData({ pullRefresh: false }))
  },

  onProfile(e) {
    const name = e.currentTarget.dataset.name
    if (!name || name === this.data.profile) return
    this.allItems = []
    this.defaultCwdTried = false
    this.wsOpen = {}
    this.wsSearchOpen = {}
    this.nsModelBody = null
    this.nsModelCacheKey = ''
    this.nsLoading = null
    this.nsSeq = (this.nsSeq || 0) + 1
    this.setData({
      profile: name,
      profileLabel: name || 'default',
      groups: [],
      recentList: [],
      recentWs: [],
      loading: true,
      error: '',
      defaultCwd: '',
      defaultCwdShort: '',
      hasAny: false,
      shownCount: 0,
      allCount: 0,
      nsModelLoading: false,
      nsListMore: false,
      tab: 'all',
      query: '',
      nsModel: '',
      nsModelShort: '',
      nsProvider: '',
      nsProviderName: '',
      nsProviders: [],
      nsModelOpen: false,
      nsModelError: '',
      nsList: [],
      nsSearch: '',
      nsReasoning: '',
      nsReasoningLabel: '默认',
      nsReasoningAvailable: true
    })
    this.resetCronState()
    store.setSettings(this.endpoint.id, { profile: name })
    this.buildTabs()
    this.load()
    this.loadDefaultCwd()
  },

  resetCronState() {
    this.cronLoading = false
    this.cronPromise = null
    this.cronSeq = (this.cronSeq || 0) + 1
    this.setData({
      cronJobs: [],
      cronList: [],
      cronLoaded: false,
      cronLoading: false,
      cronError: '',
      cronUnavailable: false,
      cronRecent: [],
      cronBusyId: ''
    })
  },

  loadCron(force) {
    if (!this.endpoint) return Promise.resolve()
    if (this.cronLoading) return this.cronPromise || Promise.resolve()
    const endpointId = this.endpoint.id
    const seq = (this.cronSeq || 0) + 1
    this.cronSeq = seq
    this.cronLoading = true
    if (force || !this.data.cronLoaded) this.setData({ cronLoading: true, cronError: '' })
    this.cronPromise = cron.list(this.endpoint, this.data.profile)
      .then((body) => {
        if (!this.endpoint || this.endpoint.id !== endpointId || seq !== this.cronSeq) return
        this.cronLoading = false
        this.setData({
          cronJobs: body.jobs || [],
          cronLoaded: true,
          cronLoading: false,
          cronError: '',
          cronUnavailable: !!body.unavailable
        })
        this.buildTabs()
        this.applyFilters()
      })
      .catch((err) => {
        if (!this.endpoint || this.endpoint.id !== endpointId || seq !== this.cronSeq) return
        this.cronLoading = false
        if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          this.setData({ cronLoading: false })
          this.onAuthExpired()
          return
        }
        this.setData({ cronLoading: false, cronLoaded: true, cronError: util.errorText(err) })
      })
    return this.cronPromise
  },

  onCronRetry() {
    if (this.cronLoading) return
    this.loadCron(true)
  },

  // ── navigation ────────────────────────────────────────────────────

  onSites() {
    wx.reLaunch({ url: '/pages/endpoints/index' })
  },

  onSiteTap() {
    const sites = store.list()
    if (sites.length <= 1) {
      wx.reLaunch({ url: '/pages/endpoints/index' })
      return
    }
    const limit = 5
    const shown = sites.slice(0, limit)
    const labels = shown.map((s) => (s.id === this.endpoint.id ? '● ' : '') + s.label)
    labels.push(sites.length > limit ? '更多站点…' : '管理站点…')
    wx.showActionSheet({
      itemList: labels,
      success: (res) => {
        if (res.tapIndex >= shown.length) {
          wx.reLaunch({ url: '/pages/endpoints/index' })
          return
        }
        const ep = shown[res.tapIndex]
        if (!ep || ep.id === this.endpoint.id) return
        this.switchSite(ep)
      }
    })
  },

  switchSite(ep) {
    this.endpoint = ep
    this.profilesPromise = null
    this.loadSeq = 0
    this.prompted = false
    this.authRecovered = false
    this.defaultCwdTried = false
    this.allItems = []
    this.wsOpen = {}
    this.wsSearchOpen = {}
    this.nsModelBody = null
    this.nsModelCacheKey = ''
    this.nsLoading = null
    this.nsSeq = (this.nsSeq || 0) + 1
    store.setActiveId(ep.id)
    store.touch(ep.id)
    const profile = store.getSettings(ep.id).profile || ''
    this.setData({
      endpoint: ep,
      endpointLabel: ep.label,
      endpointUrl: ep.baseUrl,
      profile: profile,
      profileLabel: profile || 'default',
      profiles: [],
      groups: [],
      recentList: [],
      recentWs: [],
      tab: 'all',
      query: '',
      loading: true,
      error: '',
      pullRefresh: false,
      hasAny: false,
      shownCount: 0,
      allCount: 0,
      defaultCwd: '',
      defaultCwdShort: '',
      nsModelLoading: false,
      nsListMore: false,
      nsModel: '',
      nsModelShort: '',
      nsProvider: '',
      nsProviderName: '',
      nsProviders: [],
      nsModelOpen: false,
      nsModelError: '',
      nsList: [],
      nsSearch: '',
      nsReasoning: '',
      nsReasoningLabel: '默认',
      nsReasoningAvailable: true
    })
    this.resetCronState()
    this.buildTabs()
    if (!auth.hasToken(ep)) {
      this.setData({ loading: false })
      wx.showModal({
        title: '尚未登录',
        content: '「' + ep.label + '」需要先登录',
        confirmText: '去登录',
        showCancel: false,
        success: (res) => {
          if (res.confirm) wx.redirectTo({ url: '/pages/endpoint-form/index?id=' + ep.id + '&relogin=1' })
        }
      })
      return
    }
    this.loadProfiles().then(() => {
      this.load()
      this.loadDefaultCwd()
    })
  },

  openChat(cwd, sid, title, options) {
    if (!this.endpoint) return
    let url = '/pages/chat/index?id=' + encodeURIComponent(this.endpoint.id)
    if (sid) url += '&sid=' + encodeURIComponent(sid)
    if (cwd) url += '&cwd=' + encodeURIComponent(cwd)
    if (this.data.profile) url += '&profile=' + encodeURIComponent(this.data.profile)
    if (title) url += '&title=' + encodeURIComponent(title)
    const extra = options || {}
    if (extra.model) url += '&model=' + encodeURIComponent(extra.model)
    if (extra.provider) url += '&provider=' + encodeURIComponent(extra.provider)
    if (extra.reasoning) url += '&reasoning=' + encodeURIComponent(extra.reasoning)
    wx.navigateTo({ url: url })
  },

  onOpen(e) {
    if (this.longPressed) return
    const ds = e.currentTarget.dataset
    this.openChat(ds.cwd || '', ds.id || '', ds.title || '')
  },

  // ── scheduled tasks ───────────────────────────────────────────────

  onCronRecent(e) {
    const ds = e.detail || {}
    this.openChat(ds.cwd || '', ds.id || '', ds.title || '')
  },

  onCronDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id || !this.endpoint) return
    let url = '/pages/cron-form/index?id=' + encodeURIComponent(id) +
      '&ep=' + encodeURIComponent(this.endpoint.id)
    if (this.data.profile) url += '&profile=' + encodeURIComponent(this.data.profile)
    wx.navigateTo({ url: url })
  },

  patchCronJob(id, patch) {
    const jobs = (this.data.cronJobs || []).map((job) => {
      if (job.id !== id) return job
      const next = Object.assign({}, job, patch)
      if (patch.enabled !== undefined) {
        next.tone = patch.enabled ? (job.lastRunAt ? 'ok' : 'idle') : 'off'
        next.statusText = patch.enabled ? (job.lastRunAt ? '上次成功' : '等待执行') : '已暂停'
      }
      return next
    })
    this.setData({ cronJobs: jobs })
    this.buildTabs()
    this.applyFilters()
  },

  replaceCronJob(job) {
    if (!job || !job.id) return
    const jobs = (this.data.cronJobs || []).map((item) => (item.id === job.id ? job : item))
    this.setData({ cronJobs: jobs })
    this.buildTabs()
    this.applyFilters()
  },

  onCronToggle(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.cronBusyId) return
    const job = (this.data.cronJobs || []).filter((item) => item.id === id)[0]
    if (!job) return
    const next = !job.enabled
    this.patchCronJob(id, { enabled: next })
    this.setData({ cronBusyId: id })
    cron.setEnabled(this.endpoint, job, next, this.data.profile)
      .then((updated) => {
        this.setData({ cronBusyId: '' })
        if (updated) this.replaceCronJob(updated)
        wx.showToast({ title: next ? '已启用' : '已暂停', icon: 'none' })
      })
      .catch((err) => {
        this.patchCronJob(id, { enabled: !next })
        this.setData({ cronBusyId: '' })
        if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          this.onAuthExpired()
          return
        }
        wx.showToast({ title: '操作失败：' + util.errorText(err), icon: 'none' })
      })
  },

  onCronHistory(e) {
    const id = e.currentTarget.dataset.id
    const job = (this.data.cronJobs || []).filter((item) => item.id === id)[0]
    if (!job || !this.endpoint) return
    let url = '/pages/cron-history/index?id=' + encodeURIComponent(job.id) +
      '&ep=' + encodeURIComponent(this.endpoint.id) +
      '&name=' + encodeURIComponent(job.name || '')
    if (this.data.profile) url += '&profile=' + encodeURIComponent(this.data.profile)
    wx.navigateTo({ url: url })
  },

  onGroupNew(e) {
    const cwd = e.currentTarget.dataset.cwd || ''
    this.openChat(cwd, '', '', this.newSessionOptions())
  },

  onNew() {
    this.setData({ showPicker: true })
    this.loadNewModel(false)
  },

  onPickerClose() {
    this.setData({ showPicker: false })
  },

  onPickWorkspace(e) {
    const cwd = e.currentTarget.dataset.cwd || ''
    this.setData({ showPicker: false })
    this.openChat(cwd, '', '', this.newSessionOptions())
  },

  onBrowse() {
    this.setData({
      showPicker: false,
      fsRoot: this.defaultCwd || '',
      fsShow: true
    })
  },

  onFsClose() {
    this.setData({ fsShow: false })
  },

  onFsPick(e) {
    const path = e.detail && e.detail.path
    this.setData({ fsShow: false, showPicker: false })
    if (path) this.openChat(path, '', '', this.newSessionOptions())
  },

  // ── session actions ───────────────────────────────────────────────

  onLongPress(e) {
    const id = e.currentTarget.dataset.id
    const item = (this.allItems || []).find((it) => it.id === id)
    if (!item) return
    this.longPressed = true
    if (this.longPressTimer) clearTimeout(this.longPressTimer)
    this.longPressTimer = setTimeout(() => {
      this.longPressed = false
      this.longPressTimer = null
    }, 800)
    wx.showActionSheet({
      itemList: ['重命名', '归档', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) this.rename(item)
        else if (res.tapIndex === 1) this.archive(item)
        else if (res.tapIndex === 2) this.confirmDelete(item)
      },
      complete: () => {
        this.longPressed = false
      }
    })
  },

  rename(item) {
    wx.navigateTo({
      url: '/pages/chat/index?id=' + encodeURIComponent(this.endpoint.id) +
        '&sid=' + encodeURIComponent(item.id) +
        '&cwd=' + encodeURIComponent(item.cwd || '') +
        (this.data.profile ? '&profile=' + encodeURIComponent(this.data.profile) : '') +
        '&rename=1'
    })
  },

  removeLocal(id) {
    const item = (this.allItems || []).find((it) => it.id === id)
    if (item) {
      drafts.clear(drafts.key(this.endpoint.id, item.id, item.cwd))
      const saved = last.get(this.endpoint.id)
      if (saved && saved.id === id) last.clear(this.endpoint.id)
    }
    this.allItems = (this.allItems || []).filter((it) => it.id !== id)
    this.total = Math.max(0, (this.total || 0) - 1)
    this.recentWs = workspaces.recentWorkspaces(this.allItems).slice(0, 8)
    this.buildTabs()
    this.applyFilters()
    this.setData({ recentWs: this.recentWs })
  },

  archive(item) {
    if (this.opBusy) return
    this.opBusy = true
    wx.showLoading({ title: '归档中', mask: true })
    sessionops.archive(this.endpoint, item.id, this.data.profile)
      .then(() => {
        this.opBusy = false
        wx.hideLoading()
        wx.showToast({ title: '已归档', icon: 'none' })
        this.removeLocal(item.id)
      })
      .catch((err) => {
        this.opBusy = false
        wx.hideLoading()
        wx.showToast({ title: this.opError(err, '归档'), icon: 'none' })
      })
  },

  opError(err, action) {
    if (err && err.rpcCode === 4023) return '会话正在运行，先结束会话再' + action
    if (err && (err.rpcCode === 4001 || err.rpcCode === 4007)) return '会话已不存在，请刷新'
    if (err && err.rpcCode === 4401) return '登录已过期，请重新登录'
    return util.errorText(err)
  },

  confirmDelete(item) {
    wx.showModal({
      title: '删除会话',
      content: '删除「' + item.title + '」？此操作不可恢复。',
      confirmText: '删除',
      confirmColor: '#e11d48',
      success: (res) => {
        if (!res.confirm || this.opBusy) return
        this.opBusy = true
        wx.showLoading({ title: '删除中', mask: true })
        sessionops.remove(this.endpoint, item.id, this.data.profile)
          .then(() => {
            this.opBusy = false
            wx.hideLoading()
            wx.showToast({ title: '已删除', icon: 'none' })
            this.removeLocal(item.id)
          })
          .catch((err) => {
            this.opBusy = false
            wx.hideLoading()
            wx.showToast({ title: this.opError(err, '删除'), icon: 'none' })
          })
      }
    })
  },

  onAuthExpired() {
    if (this.prompted) return
    this.prompted = true
    // 续期过一次仍然 401：不再循环续期。
    if (this.authRecovered) {
      this.showAuthPrompt()
      return
    }
    // 先静默续期，成功就恢复列表；失败才要求输入密码。
    auth.recover(this.endpoint).then(() => {
      if (this.destroyed) return
      this.authRecovered = true
      this.prompted = false
      this.setData({ error: '' })
      // profile / 默认目录在过期时可能已经失败并被缓存，恢复登录后重新取一次。
      this.profilesPromise = null
      this.defaultCwdTried = false
      this.loadProfiles().then(() => {
        this.load()
        this.loadDefaultCwd()
      }, () => this.load())
    }, () => {
      if (this.destroyed) return
      this.showAuthPrompt()
    })
  },

  showAuthPrompt() {
    wx.showModal({
      title: '登录已过期',
      content: '需要重新登录该站点',
      confirmText: '去登录',
      success: (res) => {
        if (!res.confirm) {
          this.onSites()
          return
        }
        wx.redirectTo({ url: '/pages/endpoint-form/index?id=' + this.endpoint.id + '&relogin=1&auto=1' })
      }
    })
  },

  onUnload() {
    this.destroyed = true
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
  },

  // ── theme ─────────────────────────────────────────────────────────

  onThemeOpen() {
    this.setData({ showTheme: true })
  },

  onThemeClose() {
    this.setData({ showTheme: false })
  },

  onThemePick(e) {
    const id = e.currentTarget.dataset.id
    const picked = theme.pick(id, this)
    wx.showToast({ title: '已切换「' + picked.name + '」', icon: 'none' })
  }
})
