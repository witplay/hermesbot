const store = require('../../utils/store')
const auth = require('../../utils/auth')
const theme = require('../../utils/theme')
const last = require('../../utils/last')
const sessionops = require('../../utils/sessionops')
const util = require('../../utils/util')

Page({
  data: {
    statusText: '正在唤醒最近会话…',
    error: '',
    theme: '',
    themeName: '',
    themeOptions: [],
    themeVars: '',
    showTheme: false
  },

  onLoad() {
    theme.apply(this)
    this.ready = false
    this.launched = false
    this.destroyed = false
    this.pendingUrl = ''
    const endpoint = this.pickEndpoint()
    if (!endpoint) {
      this.setData({ statusText: '还没有站点' })
      this.go('/pages/endpoints/index', 420)
      return
    }
    if (!auth.hasToken(endpoint)) {
      this.setData({ statusText: '需要先登录站点' })
      this.go('/pages/endpoints/index', 420)
      return
    }
    this.endpoint = endpoint
    store.setActiveId(endpoint.id)
    store.touch(endpoint.id)
    this.profile = store.getSettings(endpoint.id).profile || ''
    this.resolve(endpoint)
  },

  pickEndpoint() {
    const activeId = store.getActiveId()
    const active = activeId ? store.get(activeId) : null
    if (active) return active
    const list = store.list()
    return list.length ? list[0] : null
  },

  resolve(endpoint) {
    sessionops.list(endpoint, this.profile, 30)
      .then((body) => {
        if (this.destroyed) return
        const rows = body.sessions || []
        if (!rows.length) {
          this.setData({ statusText: '暂无会话，进入站点…' })
          this.go('/pages/sessions/index?id=' + endpoint.id, 420)
          return
        }
        const saved = last.get(endpoint.id)
        let row = saved ? rows.filter((item) => item.id === saved.id)[0] : null
        if (!row) row = rows[0]
        last.set(endpoint.id, {
          id: row.id,
          title: row.title || '',
          cwd: row.cwd || '',
          profile: this.profile
        })
        let url = '/pages/chat/index?id=' + endpoint.id +
          '&sid=' + encodeURIComponent(row.id)
        if (this.profile) url += '&profile=' + encodeURIComponent(this.profile)
        if (row.cwd) url += '&cwd=' + encodeURIComponent(row.cwd)
        this.setData({ statusText: '正在打开「' + (row.title || '未命名会话') + '」' })
        this.go(url, 260)
      })
      .catch((err) => {
        if (this.destroyed) return
        if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          // 令牌过期先尝试静默续期（自动登录），只有续期被服务端拒绝才让用户输密码。
          if (!this.recoverTried) {
            this.recoverTried = true
            this.setData({ statusText: '登录已过期，正在自动登录…', error: '' })
            auth.recover(endpoint)
              .then(() => {
                if (this.destroyed) return
                this.resolve(endpoint)
              })
              .catch(() => {
                if (!this.destroyed) this.toRelogin(endpoint, err)
              })
            return
          }
          this.toRelogin(endpoint, err)
          return
        }
        this.setData({
          statusText: '连接失败，进入站点列表',
          error: util.errorText(err)
        })
        this.go('/pages/sessions/index?id=' + endpoint.id, 900)
      })
  },

  toRelogin(endpoint, err) {
    this.setData({ statusText: '登录已过期，请重新登录', error: util.errorText(err) })
    this.go('/pages/endpoint-form/index?id=' + endpoint.id + '&relogin=1&auto=1', 700)
  },

  // The launch page is always the app root. Leaving it with reLaunch clears the
  // page stack while appLaunch may still be in flight, which the base library
  // rejects with "appLaunch with non-empty page stack". redirectTo swaps the
  // root page in place, so wait for the first render before switching.
  onReady() {
    this.launched = true
    if (this.pendingUrl) {
      const url = this.pendingUrl
      this.pendingUrl = ''
      this.navNow(url)
    }
  },

  onUnload() {
    this.destroyed = true
    if (this.navTimer) {
      clearTimeout(this.navTimer)
      this.navTimer = null
    }
  },

  go(url, delay) {
    if (this.destroyed || this.ready) return
    this.ready = true
    this.navTimer = setTimeout(() => {
      this.navTimer = null
      if (this.destroyed) return
      if (this.launched) this.navNow(url)
      else this.pendingUrl = url
    }, delay || 300)
  },

  navNow(url) {
    wx.redirectTo({
      url: url,
      fail: () => wx.reLaunch({ url: url })
    })
  },

  onThemeOpen() {
    // The splash normally redirects within a few hundred milliseconds. If the
    // user explicitly opens the theme sheet, stop the redirect so the sheet is
    // usable; closing it resumes the normal launch flow.
    if (this.navTimer) {
      clearTimeout(this.navTimer)
      this.navTimer = null
    }
    this.themePausedNav = true
    this.ready = true
    this.pendingUrl = ''
    this.setData({
      showTheme: true,
      statusText: '已暂停自动进入，正在设置主题'
    })
  },

  resumeLaunch() {
    if (this.destroyed || !this.themePausedNav) return
    this.themePausedNav = false
    if (!this.endpoint) return
    this.ready = false
    this.setData({ statusText: '正在唤醒最近会话…' })
    this.resolve(this.endpoint)
  },

  onThemeClose() {
    this.setData({ showTheme: false })
    this.resumeLaunch()
  },

  onThemePick(e) {
    const id = e.currentTarget.dataset.id
    const picked = theme.pick(id, this)
    wx.showToast({ title: '已切换「' + picked.name + '」', icon: 'none' })
    this.resumeLaunch()
  },

  onPickSite() {
    // Footer action must always win over the auto-open timer, otherwise the
    // splash screen cannot be escaped while it is resolving the last session.
    this.ready = true
    if (this.navTimer) {
      clearTimeout(this.navTimer)
      this.navTimer = null
    }
    this.pendingUrl = ''
    this.setData({ showTheme: false })
    this.navNow('/pages/endpoints/index')
  }
})
