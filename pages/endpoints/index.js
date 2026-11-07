const store = require('../../utils/store')
const auth = require('../../utils/auth')
const util = require('../../utils/util')
const theme = require('../../utils/theme')

const STATUS_TEXT = {
  ok: '在线',
  auth: '未登录',
  err: '无法连接',
  checking: '检查中'
}

Page({
  data: {
    items: [],
    ready: false,
    online: 0,
    showTheme: false,
    theme: '',
    themeName: '',
    themeOptions: [],
    themeVars: ''
  },

  onShow() {
    this.destroyed = false
    theme.apply(this)
    this.refresh()
  },

  refresh() {
    const items = store.list().map((ep) => {
      const status = auth.hasToken(ep) ? 'checking' : 'auth'
      return {
        id: ep.id,
        label: ep.label,
        baseUrl: ep.baseUrl,
        status: status,
        statusText: STATUS_TEXT[status],
        lastUsedText: ep.lastUsedAt ? util.formatTime(ep.lastUsedAt) : '尚未使用'
      }
    })
    this.setData({ items: items, ready: true, online: this.countOnline(items) })
    this.checkAll()
  },

  countOnline(items) {
    return (items || []).filter((it) => it.status === 'ok').length
  },

  checkAll() {
    store.list().forEach((ep) => {
      if (!auth.hasToken(ep)) return
      auth.check(ep).then((result) => {
        if (result.ok) return 'ok'
        if (result.statusCode === 401 || result.code === auth.AUTH_REQUIRED) {
          // 登录过期时先自动续期；不要立刻清掉本地令牌，否则 refresh token
          // 也会一起丢失，用户每次打开都必须重新输密码。
          return auth.recover(ep)
            .then(() => auth.check(ep))
            .then((retry) => (retry.ok ? 'ok' : 'auth'), () => 'auth')
        }
        return 'err'
      }).then((status) => {
        this.patch(ep.id, { status: status, statusText: STATUS_TEXT[status] })
      })
    })
  },

  patch(id, patch) {
    if (this.destroyed) return
    const items = this.data.items.map((it) => (it.id === id ? Object.assign({}, it, patch) : it))
    this.setData({ items: items, online: this.countOnline(items) })
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/endpoint-form/index' })
  },

  onTap(e) {
    if (this.longPressed) return
    const id = e.currentTarget.dataset.id
    const ep = store.get(id)
    if (!ep) return
    if (!auth.hasToken(ep)) {
      wx.navigateTo({ url: '/pages/endpoint-form/index?id=' + id + '&relogin=1' })
      return
    }
    store.setActiveId(id)
    store.touch(id)
    wx.navigateTo({ url: '/pages/sessions/index?id=' + id })
  },

  onLongPress(e) {
    const id = e.currentTarget.dataset.id
    const ep = store.get(id)
    if (!ep) return
    this.longPressed = true
    if (this.longPressTimer) clearTimeout(this.longPressTimer)
    this.longPressTimer = setTimeout(() => {
      this.longPressed = false
      this.longPressTimer = null
    }, 800)
    wx.showActionSheet({
      itemList: ['编辑', '重新登录', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: '/pages/endpoint-form/index?id=' + id })
        } else if (res.tapIndex === 1) {
          // Keep the current token until the new login succeeds, so cancelling
          // the form does not silently sign the user out.
          wx.navigateTo({ url: '/pages/endpoint-form/index?id=' + id + '&relogin=1' })
        } else if (res.tapIndex === 2) {
          this.confirmDelete(ep)
        }
      },
      complete: () => {
        this.longPressed = false
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

  confirmDelete(ep) {
    wx.showModal({
      title: '删除站点',
      content: '确定删除「' + ep.label + '」？本地登录状态也会一并清除。',
      confirmText: '删除',
      confirmColor: '#e11d48',
      success: (res) => {
        if (!res.confirm) return
        if (!store.remove(ep.id)) {
          wx.showToast({ title: '删除失败，请清理存储空间后重试', icon: 'none' })
          return
        }
        this.refresh()
      }
    })
  },

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
