const files = require('../../utils/files')
const util = require('../../utils/util')

const CRUMB_MAX = 4
const CRUMB_TAIL = 2

Component({
  options: {
    // app.wxss supplies btn/grow/ellipsis/dot utilities used by this sheet.
    addGlobalClass: true
  },

  properties: {
    show: { type: Boolean, value: false },
    endpoint: { type: Object, value: null },
    rootPath: { type: String, value: '' },
    focusPath: { type: String, value: '' },
    profile: { type: String, value: '' },
    sessionId: { type: String, value: '' },
    mode: { type: String, value: 'browse' },
    title: { type: String, value: '工作目录' }
  },

  data: {
    path: '',
    entries: [],
    loading: false,
    error: '',
    crumbs: [],
    visibleCrumbs: [],
    pathExpanded: false,
    pathTruncated: false,
    crumbAnchor: '',
    ddOpen: false,
    ddAnchor: '',
    ddPath: '',
    ddLeft: 0,
    ddTop: 0,
    ddWidth: 0,
    ddDirs: [],
    ddLoading: false,
    ddError: '',
    ddScroll: '',
    topAnchor: 'topA',
    topFlip: false,
    focusIndex: -1,
    previewOpen: false,
    preview: { title: '', path: '', text: '', loading: false, error: '', truncated: false }
  },

  observers: {
    show: function (show) {
      if (!show) {
        this._loadSeq = (this._loadSeq || 0) + 1
        this._previewSeq = (this._previewSeq || 0) + 1
        if (this._rootTimer) {
          clearTimeout(this._rootTimer)
          this._rootTimer = null
        }
        this.closeDd()
        this.setData({ previewOpen: false })
        return
      }
      this.scheduleOpenRoot()
    },
    // Parent pages change rootPath while the sheet is already visible (for
    // example "open containing folder" from a file card).
    rootPath: function () {
      if (this.data.show) this.scheduleOpenRoot()
    }
  },

  methods: {
    noop() {},

    scheduleOpenRoot() {
      if (this._rootTimer) clearTimeout(this._rootTimer)
      this._rootTimer = setTimeout(() => {
        this._rootTimer = null
        if (this.data.show) this.openRoot()
      }, 0)
    },

    openRoot() {
      if (!this.data.endpoint) return
      this.closeDd()
      this.setData({
        error: '',
        entries: [],
        path: '',
        crumbs: [],
        visibleCrumbs: [],
        pathExpanded: false,
        pathTruncated: false,
        crumbAnchor: '',
        previewOpen: false
      })
      const root = this.data.rootPath
      if (root) {
        this.load(root)
        return
      }
      this.setData({ loading: true })
      files.defaultCwd(this.data.endpoint, this.data.profile)
        .then((body) => this.load(body.cwd || '/'))
        .catch((err) => {
          this.setData({ loading: false, error: util.errorText(err) })
        })
    },

    load(path) {
      if (!this.data.endpoint || !this.data.show) return
      const target = path || '/'
      const seq = (this._loadSeq || 0) + 1
      this._loadSeq = seq
      this.closeDd()
      this.showPath(target)
      this.setData({ loading: true, error: '' })
      files.list(this.data.endpoint, target, this.data.profile)
        .then((body) => {
          if (this._destroyed || seq !== this._loadSeq) return
          const entries = body.entries || []
          this.showPath(body.path || target)
          const flip = !this.data.topFlip
          const focus = String(this.data.focusPath || '')
          let focusIndex = -1
          if (focus) {
            for (let k = 0; k < entries.length; k++) {
              if (entries[k].path === focus) {
                focusIndex = k
                break
              }
            }
          }
          this.setData({
            entries: entries,
            loading: false,
            focusIndex: focusIndex,
            topFlip: flip,
            topAnchor: focusIndex >= 0 ? 'fsrow' + focusIndex : (flip ? 'topA' : 'topB')
          })
        })
        .catch((err) => {
          if (this._destroyed || seq !== this._loadSeq) return
          this.setData({ loading: false, error: util.errorText(err), entries: [] })
        })
    },

    showPath(path) {
      const crumbs = this.buildCrumbs(path)
      const view = this.crumbView(crumbs, false)
      this.setData({
        path: path,
        crumbs: crumbs,
        visibleCrumbs: view.visibleCrumbs,
        pathTruncated: view.pathTruncated,
        pathExpanded: false,
        crumbAnchor: view.lastCrumbId
      })
      return view
    },

    buildCrumbs(path) {
      const value = String(path || '/').replace(/\\/g, '/')
      const drive = value.match(/^([a-zA-Z]:)(?:\/|$)/)
      const root = drive ? drive[1] + '/' : '/'
      const rest = drive ? value.slice(2).replace(/^\/+/, '') : value.replace(/^\/+/, '')
      const crumbs = [{ name: root, path: root, id: 'crumb0' }]
      let acc = root
      rest.split('/').filter(Boolean).forEach((part) => {
        acc = acc.replace(/\/+$/, '') + '/' + part
        crumbs.push({ name: part, path: acc, id: 'crumb' + crumbs.length })
      })
      return crumbs
    },

    crumbView(crumbs, expanded) {
      const last = crumbs.length - 1
      const truncated = crumbs.length > CRUMB_MAX
      const items = []
      const push = (index) => {
        const crumb = crumbs[index]
        items.push({
          id: crumb.id,
          name: crumb.name,
          path: crumb.path,
          index: index,
          on: index === last,
          more: false
        })
      }
      if (!truncated || expanded) {
        for (let i = 0; i <= last; i++) push(i)
      } else {
        push(0)
        items.push({ id: 'fs-more', name: '', path: '', index: -1, on: false, more: true })
        for (let i = Math.max(1, crumbs.length - CRUMB_TAIL); i <= last; i++) push(i)
      }
      items.forEach((item, i) => {
        const next = items[i + 1]
        item.sep = !!next
        if (item.more) {
          item.sepId = 'ddm'
          item.sepIndex = next ? next.index - 1 : -1
        } else {
          item.sepId = 'dd' + item.index
          item.sepIndex = item.index
        }
      })
      return {
        visibleCrumbs: items,
        pathTruncated: truncated,
        lastCrumbId: crumbs[last].id
      }
    },

    scrollCrumbs(id) {
      this.setData({ crumbAnchor: '' }, () => {
        if (id && !this._destroyed) this.setData({ crumbAnchor: id })
      })
    },

    onPathExpand() {
      if (!this.data.pathTruncated || this.data.pathExpanded) return
      const view = this.crumbView(this.data.crumbs, true)
      this.setData({ visibleCrumbs: view.visibleCrumbs, pathExpanded: true })
      this.scrollCrumbs('crumb0')
    },

    onPathCollapse() {
      if (!this.data.pathExpanded) return
      const view = this.crumbView(this.data.crumbs, false)
      this.setData({ visibleCrumbs: view.visibleCrumbs, pathExpanded: false })
      this.scrollCrumbs(view.lastCrumbId)
    },

    onCrumbMenu(e) {
      const index = Number(e.currentTarget.dataset.index)
      const sepId = String(e.currentTarget.dataset.sep || '')
      const crumb = this.data.crumbs[index]
      if (!sepId || !crumb || !this.data.endpoint) return
      if (this.data.ddOpen && this.data.ddAnchor === sepId) {
        this.closeDd()
        return
      }
      this.setData({
        ddOpen: true,
        ddAnchor: sepId,
        ddPath: crumb.path,
        ddDirs: [],
        ddLoading: true,
        ddError: '',
        ddScroll: ''
      }, () => this.placeDd(sepId))
      this.loadDirMenu(crumb.path)
    },

    placeDd(sepId) {
      const query = wx.createSelectorQuery().in(this)
      query.select('#' + sepId).boundingClientRect()
      query.exec((res) => {
        if (this._destroyed || this.data.ddAnchor !== sepId) return
        const rect = res && res[0]
        if (!rect) {
          // The path bar may still be inside the sheet's rise animation.
          if (!this._ddRetry) {
            this._ddRetry = true
            setTimeout(() => {
              this._ddRetry = false
              if (!this._destroyed && this.data.ddOpen) this.placeDd(sepId)
            }, 60)
          }
          return
        }
        const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const winW = info.windowWidth || 375
        const winH = info.windowHeight || 667
        const width = Math.min(winW - 24, Math.max(232, Math.round(winW * 0.84)))
        let left = rect.left + rect.width / 2 - width / 2
        left = Math.max(12, Math.min(left, winW - width - 12))
        this.setData({
          ddLeft: Math.round(left),
          ddTop: Math.round(Math.min(rect.bottom + 8, winH - 120)),
          ddWidth: Math.round(width)
        })
      })
    },

    loadDirMenu(path) {
      const seq = (this._ddSeq || 0) + 1
      this._ddSeq = seq
      files.list(this.data.endpoint, path, this.data.profile)
        .then((body) => {
          if (this._destroyed || seq !== this._ddSeq) return
          const dirs = (body.entries || [])
            .filter((entry) => entry.isDirectory)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entry) => ({
              name: entry.name,
              path: entry.path,
              current: entry.path === this.data.path
            }))
          this.setData({ ddDirs: dirs, ddLoading: false }, () => {
            if (this._destroyed || seq !== this._ddSeq) return
            for (let i = 0; i < dirs.length; i++) {
              if (dirs[i].current) {
                this.setData({ ddScroll: 'ddrow' + i })
                break
              }
            }
          })
        })
        .catch((err) => {
          if (this._destroyed || seq !== this._ddSeq) return
          this.setData({ ddLoading: false, ddError: util.errorText(err) })
        })
    },

    onDirPick(e) {
      const path = String(e.currentTarget.dataset.path || '')
      if (!path) return
      this.closeDd()
      if (path === this.data.path) return
      this.load(path)
    },

    onDdClose() {
      this.closeDd()
    },

    closeDd() {
      this._ddSeq = (this._ddSeq || 0) + 1
      if (this.data.ddOpen) {
        this.setData({
          ddOpen: false,
          ddAnchor: '',
          ddDirs: [],
          ddLoading: false,
          ddError: '',
          ddScroll: ''
        })
      }
    },

    onClose() {
      this._loadSeq = (this._loadSeq || 0) + 1
      this._previewSeq = (this._previewSeq || 0) + 1
      this.closeDd()
      this.setData({ previewOpen: false })
      this.triggerEvent('close')
    },

    onMask() {
      this.onClose()
    },

    onRefresh() {
      if (this.data.loading) return
      if (this.data.path) this.load(this.data.path)
      else this.openRoot()
    },

    onUp() {
      const path = this.data.path
      if (!path || path === '/') return
      const parent = files.parentPath(path)
      if (!parent || parent === path) return
      this.load(parent)
    },

    onCrumb(e) {
      const index = Number(e.currentTarget.dataset.index)
      const crumb = this.data.crumbs[index]
      if (!crumb || crumb.path === this.data.path) return
      this.load(crumb.path)
    },

    onEntry(e) {
      const entry = this.data.entries[Number(e.currentTarget.dataset.index)]
      if (!entry) return
      if (entry.isDirectory) {
        this.load(entry.path)
        return
      }
      if (entry.isImage) {
        wx.showLoading({ title: '加载图片', mask: true })
        files.previewPath(this.data.endpoint, entry.path, this.data.profile)
          .then(() => wx.hideLoading())
          .catch((err) => {
            wx.hideLoading()
            wx.showToast({ title: util.errorText(err), icon: 'none' })
          })
        return
      }
      if (entry.isText) {
        this.openPreview(entry.path, entry.name)
        return
      }
      wx.showActionSheet({
        itemList: ['下载并打开', '复制路径'],
        success: (res) => {
          if (res.tapIndex === 0) this.download(entry)
          else if (res.tapIndex === 1) wx.setClipboardData({ data: entry.path })
        }
      })
    },

    download(entry) {
      wx.showLoading({ title: '下载中', mask: true })
      files.open(this.data.endpoint, entry.path, this.data.profile, entry.name)
        .then(() => wx.hideLoading())
        .catch((err) => {
          wx.hideLoading()
          wx.showToast({ title: err && err.code === 'OPEN' ? '文件已下载，当前类型无法直接打开' : util.errorText(err), icon: 'none' })
        })
    },

    openPreview(path, name) {
      this.closeDd()
      const seq = (this._previewSeq || 0) + 1
      this._previewSeq = seq
      this.setData({
        previewOpen: true,
        preview: { title: name || path, path: path, text: '', loading: true, error: '', truncated: false }
      })
      files.readText(this.data.endpoint, path, this.data.profile)
        .then((body) => {
          if (this._destroyed || seq !== this._previewSeq) return
          this.setData({
            'preview.text': body.text || '',
            'preview.truncated': !!body.truncated,
            'preview.loading': false
          })
        })
        .catch((err) => {
          if (this._destroyed || seq !== this._previewSeq) return
          this.setData({ 'preview.loading': false, 'preview.error': util.errorText(err) })
        })
    },

    onPreviewClose() {
      this._previewSeq = (this._previewSeq || 0) + 1
      this.setData({ previewOpen: false })
    },

    onPreviewDownload() {
      const preview = this.data.preview
      if (!preview.path) return
      wx.showLoading({ title: '下载中', mask: true })
      files.open(this.data.endpoint, preview.path, this.data.profile, preview.title)
        .then(() => wx.hideLoading())
        .catch((err) => {
          wx.hideLoading()
          wx.showToast({ title: err && err.code === 'OPEN' ? '文件已下载，当前类型无法直接打开' : util.errorText(err), icon: 'none' })
        })
    },

    onPreviewCopy() {
      if (this.data.preview.text) wx.setClipboardData({ data: this.data.preview.text })
    },

    onPick() {
      const path = this.data.path
      if (!path || this.data.loading) return
      this.triggerEvent('pick', { path: path })
    },

    attached() {
      this._destroyed = false
    },

    detached() {
      this._destroyed = true
      if (this._rootTimer) {
        clearTimeout(this._rootTimer)
        this._rootTimer = null
      }
      this._loadSeq = (this._loadSeq || 0) + 1
      this._previewSeq = (this._previewSeq || 0) + 1
    }
  }
})
