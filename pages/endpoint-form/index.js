const store = require('../../utils/store')
const auth = require('../../utils/auth')
const http = require('../../utils/http')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

Page({
  data: {
    id: '',
    label: '',
    baseUrl: '',
    username: '',
    password: '',
    accessToken: '',
    advanced: false,
    isNew: true,
    loading: false,
    loadingText: '',
    theme: '',
    themeVars: ''
  },

  onLoad(options) {
    theme.apply(this)
    const id = options.id || ''
    const endpoint = id ? store.get(id) : null
    this.destroyed = false
    this.relogin = !!options.relogin
    this.needsLogin = this.relogin
    if (endpoint) {
      this.setData({
        id: endpoint.id,
        label: endpoint.label,
        baseUrl: endpoint.baseUrl,
        username: endpoint.username || '',
        isNew: false
      })
      wx.setNavigationBarTitle({ title: '编辑站点' })
      // 由页面检测到登录过期跳转过来的：先用已有令牌静默登录，成功就直接
      // 进去，不再打断用户要密码。手动「重新登录」不带 auto，保持原行为。
      if (this.relogin && options.auto === '1' && auth.hasToken(endpoint)) {
        this.autoLogin(endpoint)
      }
    } else {
      wx.setNavigationBarTitle({ title: '添加站点' })
    }
  },

  onUnload() {
    this.destroyed = true
  },

  autoLogin(endpoint) {
    this.setData({ loading: true, loadingText: '正在自动登录…' })
    auth.recover(endpoint).then(() => {
      if (this.destroyed) return
      this.relogin = false
      this.needsLogin = false
      store.setActiveId(endpoint.id)
      this.setData({ loading: false, loadingText: '', password: '' })
      wx.redirectTo({ url: '/pages/sessions/index?id=' + endpoint.id })
    }, () => {
      if (this.destroyed) return
      this.setData({ loading: false, loadingText: '' })
    })
  },

  onShow() {
    theme.apply(this)
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
    this.setData(patch)
  },

  onToggleAdvanced() {
    this.setData({ advanced: !this.data.advanced })
  },

  // Pure validation: never write to storage before the credentials and URL are
  // known to be usable. The previous implementation saved first, which created
  // a ghost site on the first failed attempt and a duplicate site on every retry
  // because the generated id was never copied back into page data.
  buildEndpoint() {
    const rawUrl = String(this.data.baseUrl || '').trim()
    if (!rawUrl) {
      wx.showToast({ title: '请填写服务地址', icon: 'none' })
      return null
    }
    const baseUrl = store.normalizeUrl(rawUrl)
    if (!baseUrl || !store.isValidBaseUrl(baseUrl)) {
      wx.showToast({ title: '地址格式不正确', icon: 'none' })
      return null
    }
    return {
      id: this.data.id,
      label: this.data.label,
      baseUrl: baseUrl,
      username: (this.data.username || '').trim()
    }
  },

  saveEndpoint(draft) {
    const endpoint = store.save(draft)
    if (this.data.id !== endpoint.id || this.data.isNew) {
      this.setData({ id: endpoint.id, isNew: false })
    }
    return endpoint
  },

  promptRelogin() {
    this.needsLogin = true
    this.setData({ password: '' })
    wx.showModal({
      title: '需要重新登录',
      content: '服务地址已变更，请填写账号密码重新登录。',
      showCancel: false
    })
  },

  onSave() {
    if (this.data.loading) return
    const draft = this.buildEndpoint()
    if (!draft) return

    const username = (this.data.username || '').trim()
    const password = this.data.password || ''
    // 密码留空表示沿用已有登录状态，此时不再要求用户名，也不再提示输密码。
    if (password && !username) {
      wx.showToast({ title: '请填写账号', icon: 'none' })
      return
    }
    if (!password) {
      this.saveReusingSession(draft)
      return
    }

    let endpoint = null
    try {
      endpoint = this.saveEndpoint(draft)
    } catch (err) {
      wx.showToast({ title: util.errorText(err), icon: 'none' })
      return
    }

    this.setData({ loading: true, loadingText: '正在登录…' })
    wx.showLoading({ title: '登录中', mask: true })

    auth.login(endpoint, username, password)
      .then(() => {
        wx.hideLoading()
        this.relogin = false
        this.needsLogin = false
        store.setActiveId(endpoint.id)
        this.setData({ loading: false, password: '' })
        wx.showToast({ title: '登录成功', icon: 'success' })
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/sessions/index?id=' + endpoint.id })
        }, 400)
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ loading: false })
        this.showLoginError(err)
      })
  },

  // 密码留空：保存表单但不碰本地令牌。有可用登录状态时先静默续期，
  // 续期成功就直接进入站点；确实没有可用状态才提示填写密码。
  saveReusingSession(draft) {
    const stored = draft.id ? store.get(draft.id) : null
    const canReuse = !!(stored && auth.hasToken(stored))
    if (!canReuse && (this.relogin || this.needsLogin)) {
      wx.showToast({ title: '无可用登录状态，请填写密码', icon: 'none' })
      return
    }
    if (!canReuse && this.data.isNew) {
      wx.showToast({ title: '首次添加请填写账号密码', icon: 'none' })
      return
    }

    let endpoint = null
    try {
      endpoint = this.saveEndpoint(draft)
    } catch (err) {
      wx.showToast({ title: util.errorText(err), icon: 'none' })
      return
    }
    if (endpoint.authCleared) {
      this.promptRelogin()
      return
    }

    if (!canReuse || (!this.relogin && !this.needsLogin)) {
      // 普通编辑（不是重新登录）只保存表单，保留当前登录状态。
      store.setActiveId(endpoint.id)
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 400)
      return
    }

    this.setData({ loading: true, loadingText: '正在恢复登录…' })
    auth.recover(endpoint).then(() => {
      this.relogin = false
      this.needsLogin = false
      store.setActiveId(endpoint.id)
      this.setData({ loading: false, loadingText: '', password: '' })
      wx.showToast({ title: '已沿用登录状态', icon: 'success' })
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/sessions/index?id=' + endpoint.id })
      }, 400)
    }, () => {
      this.setData({ loading: false, loadingText: '' })
      wx.showModal({
        title: '需要密码登录',
        content: '已有登录状态已失效，请填写密码重新登录。',
        showCancel: false
      })
    })
  },

  onTokenLogin() {
    if (this.data.loading) return
    const token = (this.data.accessToken || '').trim()
    if (!token) {
      wx.showToast({ title: '请粘贴访问令牌', icon: 'none' })
      return
    }
    const draft = this.buildEndpoint()
    if (!draft) return

    const session = {
      accessToken: token,
      refreshToken: '',
      expiresAt: 0,
      userId: '',
      provider: 'token',
      updatedAt: Date.now()
    }

    this.setData({ loading: true, loadingText: '正在验证令牌…' })
    wx.showLoading({ title: '验证中', mask: true })

    // Validate against the draft first. Do not overwrite an existing valid
    // token until the new one has actually been accepted by the server.
    http.raw(draft, {
      path: '/api/auth/me',
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      timeout: 15000
    })
      .then((res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          throw util.makeError('LOGIN_FAILED', '令牌无效或已过期')
        }
        if (res.statusCode !== 200) {
          throw util.makeError('LOGIN_FAILED', '令牌验证失败（HTTP ' + res.statusCode + '）')
        }
        const body = res.data || {}
        if (body.expires_at) session.expiresAt = body.expires_at
        if (body.user_id) session.userId = body.user_id
        if (body.provider) session.provider = body.provider

        const endpoint = this.saveEndpoint(draft)
        if (!store.setAuth(endpoint.id, session)) {
          throw util.makeError('STORAGE', '令牌保存失败，请清理存储空间后重试')
        }
        store.setActiveId(endpoint.id)
        this.relogin = false
        this.needsLogin = false
        wx.hideLoading()
        this.setData({ loading: false, accessToken: '', password: '' })
        wx.showToast({ title: '令牌有效', icon: 'success' })
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/sessions/index?id=' + endpoint.id })
        }, 400)
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ loading: false })
        this.showLoginError(err)
      })
  },

  showLoginError(err) {
    wx.showModal({
      title: '登录失败',
      content: this.loginErrorText(err),
      showCancel: false
    })
  },

  loginErrorText(err) {
    if (!err) return '登录失败'
    const message = util.errorText(err)
    if (/url not in domain list/i.test(message)) {
      return '域名未加入小程序合法域名。请在微信公众平台配置 request 与 socket 域名（如使用端口，需连同端口一起配置）。'
    }
    if (err.code === 'NETWORK') {
      return '无法连接服务：' + message +
        '\n请检查地址、端口是否可访问，并确认合法域名已配置。'
    }
    if (err.code === 'LOGIN_FAILED') {
      return message + '\n若登录成功但取不到令牌，可展开「使用访问令牌登录（高级）」。'
    }
    return message
  }
})
