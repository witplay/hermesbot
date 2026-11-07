const store = require('../../utils/store')
const util = require('../../utils/util')
const http = require('../../utils/http')
const auth = require('../../utils/auth')
const theme = require('../../utils/theme')
const Gateway = require('../../utils/gateway')
const sessionops = require('../../utils/sessionops')
const drafts = require('../../utils/drafts')
const last = require('../../utils/last')
const markdown = require('../../utils/markdown')
const files = require('../../utils/files')
const workspaces = require('../../utils/workspaces')
const models = require('../../utils/models')
const enhance = require('../../utils/enhance')

const MAX_ROWS = 240
const MAX_IMAGES = 4
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_ATTACH_BYTES = 30 * 1024 * 1024
const FLUSH_MS = 60
const INPUT_MIN = 46
const INPUT_MAX = 132
const INPUT_LINE = 22
// 输入历史：最多保留的快照数，以及连续打字合并为一步的时间窗口
const INPUT_HISTORY_LIMIT = 60
const INPUT_HISTORY_GROUP_MS = 600
const SCROLL_RESUME_GAP = 56
// 手指位移超过这个像素即视为「用户主动上滑」，哪怕只是轻微拖动
const SCROLL_UP_EPSILON = 2
const SCROLL_CHECK_MS = 80
const SCROLL_SETTLE_MS = 1600
// 抬起手指后等待惯性滚动事件到达，再决定是否补一次吸底
const SCROLL_TOUCH_SETTLE_MS = 140
// 全屏编辑：顶部留白之外，头部 + 工具栏 + 输入框外边距的固定占位，单位 px
const FS_BODY_CHROME_PX = 138
// 跨端同步：回合进行中在没有本地事件的间隙补读快照
const REMOTE_POLL_MS = 2200
// 跨端同步：空闲时探测其他端是否新开了回合
const REMOTE_IDLE_POLL_MS = 12000
// 收到实时事件后这段时间内不再轮询，避免事件与快照互相覆盖
const REMOTE_EVENT_GRACE_MS = 4000
// 本机回合以事件流为主；长时间没有事件时只做低频兜底探测
const LOCAL_EVENT_GRACE_MS = 9000
// 离开页面超过这个时长，回来时整体对齐一次快照
const RESUME_SYNC_MS = 30000

// Server wraps an injected (steered) user row in these markers; they are protocol text, not content.
const STEER_OPEN = '[OUT-OF-BAND USER MESSAGE'
const STEER_CLOSE = '[/OUT-OF-BAND USER MESSAGE]'

const CHOICE_TEXT = {
  once: '允许一次',
  session: '本会话允许',
  always: '始终允许',
  deny: '拒绝'
}

let seq = 0
let inputWidthCache = 0

function uid(prefix) {
  seq += 1
  return (prefix || 'm') + Date.now().toString(36) + seq
}

function partText(part) {
  if (typeof part === 'string') return part
  if (!part) return ''
  if (typeof part.text === 'string') return part.text
  if (part.type === 'image_url' || part.type === 'image') return '[图片]'
  return ''
}

// 思考分片可能与正文同处 content 数组里；正文不能把思考也算进去。
function reasoningPartOf(part) {
  return !!(part && typeof part === 'object' && /reason|think/i.test(String(part.type || '')))
}

function rowText(row) {
  if (!row) return ''
  if (typeof row.text === 'string' && row.text) return row.text
  const content = row.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((part) => !reasoningPartOf(part)).map(partText).filter(Boolean).join('\n')
  }
  if (content && typeof content === 'object') return reasoningPartOf(content) ? '' : partText(content)
  return ''
}

function rowTime(row) {
  if (!row) return ''
  const value = row.timestamp || row.created_at || row.time || row.ts || row.at
  return value ? util.formatTime(value) : ''
}

function cut(text, n) {
  const str = String(text || '')
  return str.length > n ? str.slice(0, n) + '…' : str
}

function reasoningPart(part) {
  if (!part) return ''
  if (typeof part === 'string') return part
  if (typeof part.text === 'string' && (!part.type || /reason|think/i.test(part.type))) return part.text
  return ''
}

// 思考正文在不同版本里可能叫 reasoning / reasoning_content / thinking，
// 也可能是分片数组；历史消息与 inflight 快照都走这里，避免只认一种字段而丢内容。
function rowReasoning(row) {
  if (!row) return ''
  const keys = ['reasoning', 'reasoning_content', 'reasoning_text', 'thinking']
  for (let i = 0; i < keys.length; i++) {
    const value = row[keys[i]]
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value)) {
      const text = value.map(reasoningPart).filter(Boolean).join('')
      if (text.trim()) return text
    }
  }
  if (Array.isArray(row.content)) {
    const text = row.content.filter(reasoningPartOf).map(reasoningPart).filter(Boolean).join('')
    if (text.trim()) return text
  }
  return ''
}

// 事件里的思考分片也可能是 text / delta / reasoning 三种字段之一。
function payloadReasoning(payload) {
  if (!payload) return ''
  const keys = ['text', 'delta', 'reasoning', 'reasoning_content', 'thinking']
  for (let i = 0; i < keys.length; i++) {
    const value = payload[keys[i]]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

// 过程按「一次思考 + 它触发的工具调用」成对组织；历史消息没有步骤时用
// 它自己的思考与工具兜底成一组，保证两种来源的渲染结构一致。
function stepsOf(msg) {
  if (msg && msg.steps && msg.steps.length) return msg.steps
  const think = (msg && msg.reasoning) || ''
  const tools = (msg && msg.tools) || []
  if (!think && !tools.length) return []
  return [{ key: 's0', think: think, tools: tools }]
}

// 折叠列表里每个气泡只需要一个能认出来的标题：首行正文 > 思考 > 工具调用
function bubbleTitleOf(msg) {
  const text = String((msg && msg.text) || '').trim()
  if (text) return cut(text.split('\n')[0].trim(), 30)
  if (msg && msg.reasoning) return '思考'
  const count = msg && msg.tools ? msg.tools.length : 0
  return count ? '工具调用 ×' + count : '过程'
}

function tailLine(text, n) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const lines = raw.split('\n').filter((line) => line.trim())
  return cut(lines.length ? lines[lines.length - 1].trim() : raw, n)
}

// Every assistant bubble carries the same shape; `showReasoning` folds the
// process (thinking + tool calls) that sits between the prompt and the answer.
function assistantMsg(fields) {
  return Object.assign({
    id: uid('a'),
    role: 'assistant',
    text: '',
    reasoning: '',
    model: '',
    showReasoning: false,
    steps: [],
    turnIds: null,
    turnCount: 0,
    turnHidden: false,
    turnHasThink: false,
    turnBubbles: [],
    tools: [],
    status: 'done',
    blocks: [],
    mdImages: [],
    fileCards: [],
    timeText: ''
  }, fields || {})
}

function stripSteer(text) {
  let str = String(text || '')
  const open = str.indexOf(STEER_OPEN)
  if (open < 0) return str
  const close = str.indexOf(STEER_CLOSE, open)
  if (close < 0) return (str.slice(0, open) + str.slice(open + STEER_OPEN.length)).trim()
  const headEnd = str.indexOf(']', open)
  const body = str.slice(headEnd >= 0 && headEnd < close ? headEnd + 1 : open + STEER_OPEN.length, close)
  return (str.slice(0, open) + body + str.slice(close + STEER_CLOSE.length)).trim()
}

function normalizePromptText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

// 历史里的用户行与 inflight.user 应当是同一条输入；比较前归一化空白。
function samePromptText(a, b) {
  const x = normalizePromptText(a)
  const y = normalizePromptText(b)
  return !!x && x === y
}

// 历史里可能已经落了同一段回复的前半部分，用前缀关系判断是不是同一个气泡。
function sameOrPrefix(a, b) {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (!x || !y) return false
  return x.indexOf(y) === 0 || y.indexOf(x) === 0
}

// 结果优先模式下「详情 / 收起」的选择按会话记住；没有记录就是收起。
const LIVE_DETAIL_PREFIX = 'hermes.livedetail.v1.'

function liveDetailKey(endpointId, sid) {
  if (!endpointId || !sid) return ''
  return LIVE_DETAIL_PREFIX + endpointId + '.' + sid
}

function readLiveDetail(endpointId, sid) {
  const key = liveDetailKey(endpointId, sid)
  if (!key) return false
  try {
    return wx.getStorageSync(key) === true
  } catch (e) {
    return false
  }
}

function writeLiveDetail(endpointId, sid, value) {
  const key = liveDetailKey(endpointId, sid)
  if (!key) return
  try {
    if (value) wx.setStorageSync(key, true)
    else wx.removeStorageSync(key)
  } catch (e) {
    /* ignore */
  }
}

function hasDraft(text, images, files) {
  return !!(String(text || '').trim() || (images && images.length) || (files && files.length))
}

// session.steer 的结果在不同版本里可能是字符串、顶层 status 或 result.status。
function steerStatus(res) {
  if (res === undefined || res === null) return undefined
  if (typeof res === 'string') return res
  if (typeof res.status === 'string') return res.status
  if (res.result && typeof res.result.status === 'string') return res.result.status
  return undefined
}

function steerAccepted(res) {
  const status = steerStatus(res)
  if (status === 'queued' || status === 'delivered' || status === 'redirected') return true
  if (status !== undefined) return false
  // 没有状态字段时以「RPC 没有报错」为准；delivered === false 才算拒收。
  return !res || res.delivered !== false
}

// Server paths can arrive either rooted at /api or already carrying the
// reverse-proxy prefix (e.g. /hermes/api). Resolve both without doubling it.
function serverAssetUrl(endpoint, src) {
  if (!endpoint || !endpoint.baseUrl) return ''
  const raw = String(src || '')
  if (raw.charAt(0) !== '/') return ''
  const base = String(endpoint.baseUrl)
  const parts = base.match(/^(https?:\/\/[^/]+)(\/.*)?$/i)
  if (!parts) return ''
  const prefix = (parts[2] || '').replace(/\/+$/, '')
  if (prefix && (raw === prefix || raw.indexOf(prefix + '/') === 0)) return parts[1] + raw
  if (raw.indexOf('/api/') === 0) return base + raw
  return ''
}

function shortModel(id) {
  const text = String(id || '')
  const slash = text.lastIndexOf('/')
  return slash >= 0 && slash < text.length - 1 ? text.slice(slash + 1) : text
}

// 页面 URL 是用 encodeURIComponent 拼的，框架把 query 原样交回来，所以这里解码一次；
// 否则含中文的工作区路径、标题、profile 会以 "%E4%B8%AD..." 的形式显示并被发给服务端。
function urlText(options, key) {
  if (!options || options[key] == null) return ''
  const raw = String(options[key])
  if (raw.indexOf('%') < 0) return raw
  return util.safeDecode(raw)
}

function inputHeightFor(text, focused, lineCount) {
  let lines = lineCount
  if (!lines) {
    if (!inputWidthCache) {
      try { inputWidthCache = (wx.getWindowInfo().windowWidth || 375) - 48 } catch (e) { inputWidthCache = 327 }
    }
    const width = inputWidthCache
    const perLine = Math.max(16, Math.floor(width / 13))
    lines = String(text || '').split('\n').reduce((sum, line) => {
      return sum + Math.max(1, Math.ceil(line.length / perLine))
    }, 0)
  }
  const min = focused ? 66 : INPUT_MIN
  return Math.max(min, Math.min(INPUT_MAX, INPUT_LINE * (lines || 1) + 22))
}

// 表格可用宽度（rpx）：扣除气泡内边距和边框，用于判断是否需要横向滚动。
let tableAvailCache = 0
let tableAvailWin = 0
function tableAvailWidth() {
  let win = 375
  try { win = wx.getWindowInfo().windowWidth || 375 } catch (e) {
    try { win = wx.getSystemInfoSync().windowWidth || 375 } catch (e2) { /* ignore */ }
  }
  if (!win) win = 375
  if (tableAvailCache && tableAvailWin === win) return tableAvailCache
  // 平板/桌面上内容区被 max-width 限制，换算回 rpx 后可用宽度会更小。
  const pageWidth = Math.min(win, 760)
  const paddingRpx = 88 + 4 * 750 / win
  tableAvailCache = Math.max(360, Math.round(pageWidth * 750 / win - paddingRpx))
  tableAvailWin = win
  return tableAvailCache
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

function buildMsgs(rows) {
  const out = []
  let anchor = null
  ;(rows || []).slice(-MAX_ROWS).forEach((row) => {
    if (!row || row.display_kind === 'hidden') return
    if (row.role === 'user') {
      const steered = row.display_kind === 'steer' || rowText(row).indexOf(STEER_OPEN) >= 0
      out.push({
        id: uid('u'),
        role: 'user',
        text: steered ? stripSteer(rowText(row)) : rowText(row),
        images: [],
        files: [],
        status: 'done',
        steer: steered,
        timeText: rowTime(row)
      })
      anchor = null
    } else if (row.role === 'assistant') {
      const text = rowText(row)
      const reasoning = rowReasoning(row)
      if (!text && !reasoning) return
      anchor = assistantMsg({
        text: text,
        reasoning: reasoning,
        model: row.model || '',
        timeText: rowTime(row)
      })
      out.push(anchor)
    } else if (row.role === 'tool') {
      if (!anchor) {
        anchor = assistantMsg({ model: row.model || '' })
        out.push(anchor)
      }
      anchor.tools.push({
        id: row.tool_call_id || uid('t'),
        name: row.name || 'tool',
        context: row.context || '',
        summary: cut(rowText(row), 160),
        done: true,
        durationText: ''
      })
    }
  })
  return out
}

Page({
  data: {
    endpoint: null,
    endpointLabel: '',
    profile: '',
    profileLabel: 'default',
    title: '',
    wsName: '默认工作区',
    wsShort: '',
    modelLabel: '',
    modelShort: '',
    modelOpen: false,
    modelLoading: false,
    modelError: '',
    modelProviders: [],
    modelProvider: '',
    modelSearch: '',
    modelList: [],
    modelListMore: false,
    modelSwitching: false,
    reasoningLevels: models.LEVELS,
    reasoningLevel: '',
    reasoningLabel: '默认',
    reasoningAvailable: true,
    reasoningBusy: false,
    channelLabel: '会话',
    channelClass: 'session',
    statusBarHeight: 20,
    navRowHeight: 46,
    capsulePad: 96,
    connState: 'connecting',
    connText: '连接中…',
    errorBanner: '',
    statusText: '',
    msgs: [],
    loading: false,
    sending: false,
    streaming: false,
    input: '',
    draftReady: false,
    inputCanUndo: false,
    inputCanRedo: false,
    inputFocus: false,
    inputHeight: 46,
    keyboardHeight: 0,
    pendingImages: [],
    pendingFiles: [],
    queue: [],
    queuePaused: false,
    busyMode: 'queue',
    // 输入框全屏编辑
    fullscreen: false,
    fullscreenFocus: false,
    fsInputHeight: 260,
    // 全屏面板顶部留白（避开状态栏与右上角胶囊），单位 px
    fsTopPad: 0,
    // 当前回合是否由其他端发起（用于状态栏提示与轮询）
    remoteTurn: false,
    displayMode: 'flow',
    flowMode: true,
    liveStatus: null,
    // 结果优先模式：详情/收起按会话记住，新会话默认收起（只显示正文）。
    liveDetail: false,
    showScrollDown: false,
    approval: null,
    clarify: null,
    secretPrompt: null,
    usageText: '',
    recording: false,
    voiceBusy: false,
    anchorId: 'anchorA',
    detailsOpen: false,
    details: {},
    detailsTitle: '',
    detailsSaving: false,
    fsShow: false,
    fsRoot: '',
    fsFocus: '',
    showTheme: false,
    theme: '',
    themeName: '',
    themeOptions: [],
    themeVars: '',
    enhanceOpen: false,
    enhancing: false,
    enhanceReady: false,
    enhanceBaseUrl: '',
    enhanceKey: '',
    enhanceModel: '',
    enhanceReasoning: '',
    enhanceReasoningOptions: enhance.REASONING_LEVELS,
    enhancePrompt: '',
    enhanceTesting: false,
    enhanceTestMsg: '',
    enhanceTestOk: false,
    enhanceUndo: ''
  },

  onLoad(options) {
    theme.apply(this)
    this.lastThemeId = theme.current().id
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
    store.setActiveId(ep.id)
    store.touch(ep.id)
    this.profile = urlText(options, 'profile') || store.getSettings(ep.id).profile || ''
    this.storedId = urlText(options, 'sid')
    this.cwd = urlText(options, 'cwd')
    this.renameOnLoad = urlText(options, 'rename') === '1'
    this.runtimeId = ''
    this.streamMsgId = ''
    this.turnOpen = false
    this.msgs = []
    this.dirty = {}
    this.imgTasks = {}
    this.flushTimer = null
    this.title = ''
    this.approvalActive = false
    this.clarifyActive = false
    this.secretActive = false
    this.anchorFlip = false
    this.destroyed = false
    this.metaRow = null
    this.metaLoading = false
    this.modelCurrent = ''
    this.modelOptions = null
    this.defaultCwdTried = false
    this.draftTimer = null
    this.enhanceLock = false
    this.enhanceLockTimer = null
    this.pendingModel = this.storedId ? '' : urlText(options, 'model')
    this.pendingProvider = this.storedId ? '' : urlText(options, 'provider')
    this.pendingReasoning = this.storedId ? '' : urlText(options, 'reasoning')
    this.reasoningTouched = false
    this.outbox = []
    this.draining = false
    this.drainingId = ''
    this.execGen = null
    // 当前回合是不是本页发起的；不是则说明任务来自其他端。
    this.turnLocal = false
    this.localTurnAt = 0
    // 跨端状态同步：事件静默时按需轮询会话快照。
    this.lastEventAt = 0
    this.idleProbeAt = 0
    this.probeEndHits = 0
    this.watchTimer = null
    this.watching = false
    this.probing = null
    this.hidden = false
    this.hiddenAt = 0
    const settings = store.getSettings(ep.id)
    this.busyMode = settings.busyMode === 'steer' ? 'steer' : 'queue'
    // `flow` (默认) 折叠工作过程；`classic` 保留逐条展开的原有体验。
    this.displayMode = settings.displayMode === 'classic' ? 'classic' : 'flow'
    this.flowMode = this.displayMode === 'flow'
    this.liveDetail = readLiveDetail(ep.id, this.storedId)
    this.liveTimer = null
    this.liveSig = ''
    this.turnStartAt = 0
    this.turnSeq = 0
    this.autoFollow = true
    this.threadViewportHeight = 0
    this.lastScrollTop = 0
    this.lastScrollHeight = 0
    this.lastScrollDeltaY = 0
    this.userTouching = false
    this.followScrollPending = false
    this.followScrollPendingUntil = 0
    this.followCheckTimer = null
    this.settleTimer = null
    this.touchTopAtStart = null
    this.measurePending = false
    this.modelCurrent = this.pendingModel || ''
    this.reasoningLevel = this.pendingReasoning || ''
    this.reasoningLabel = models.levelLabel(this.reasoningLevel) || (this.reasoningLevel ? this.reasoningLevel : '默认')

    const metrics = screenMetrics()
    try { this.baseWindowHeight = wx.getWindowInfo().windowHeight || 0 } catch (e) { this.baseWindowHeight = 0 }
    const initialTitle = urlText(options, 'title')
    this.title = initialTitle
    const draftText = drafts.get(drafts.key(ep.id, this.storedId, this.cwd))
    this.setData(Object.assign({}, metrics, {
      endpoint: ep,
      endpointLabel: ep.label,
      profile: this.profile,
      profileLabel: this.profile || 'default',
      title: initialTitle,
      wsName: workspaces.workspaceName(this.cwd),
      wsShort: workspaces.shortPath(this.cwd),
      modelLabel: this.pendingModel,
      modelShort: this.pendingModel ? shortModel(this.pendingModel) : '',
      reasoningLevel: this.reasoningLevel,
      reasoningLabel: this.reasoningLabel,
      busyMode: this.busyMode,
      displayMode: this.displayMode,
      flowMode: this.flowMode,
      liveDetail: this.liveDetail,
      input: draftText,
      inputHeight: inputHeightFor(draftText, false),
      draftReady: hasDraft(draftText),
      enhanceReady: enhance.isReady(),
      loading: !!this.storedId
    }))
    this.resetInputHistory(draftText)

    if (this.storedId) this.saveLast()
    this.loadMeta()
    this.bindGateway()
    if (!this.storedId) this.loadModelOptions(false)
    this.restoreDraftSoon()
  },

  noop() {},

  onReady() {
    this.measureThreadViewport()
  },

  onResize() {
    inputWidthCache = 0
    // 键盘弹起也会触发 resize；此时窗口高度已被压缩，再记录会让键盘高度被算两次。
    if (!this.data.keyboardHeight) {
      try { this.baseWindowHeight = wx.getWindowInfo().windowHeight || this.baseWindowHeight } catch (e) { /* ignore */ }
    }
    this.measureThreadViewport()
    // 旋转/分屏后胶囊位置会变，顶部留白要跟着重算。
    this.syncFullscreenMetrics()
  },

  // 全屏时统一刷新「顶部留白 + 输入区高度」，进入、旋转、返回前台都走这里。
  syncFullscreenMetrics() {
    if (!this.data.fullscreen) return
    const topPad = this.computeFullscreenTop()
    this.setData({
      fsTopPad: topPad,
      fsInputHeight: this.fullscreenInputHeight(undefined, topPad)
    })
  },

  onShow() {
    try { this.baseWindowHeight = wx.getWindowInfo().windowHeight || this.baseWindowHeight } catch (e) { /* ignore */ }
    inputWidthCache = 0
    const before = this.lastThemeId
    theme.apply(this)
    const now = theme.current().id
    if (before && before !== now && this.msgs && this.msgs.length) {
      this.rebuildRich()
    }
    this.lastThemeId = now

    // 回到前台：补上离开期间其他端产生的状态变化。
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0
    this.hidden = false
    this.hiddenAt = 0
    this.syncFullscreenMetrics()
    if (!this.storedId || !this.gw) return
    // 回到前台先恢复跨端探测，再按需补一次整体对齐。
    this.startWatching()
    if (this.data.streaming) {
      this.probeSession(true)
    } else if (away >= RESUME_SYNC_MS) {
      this.syncSession()
    } else {
      this.probeSession(false)
    }
  },

  onHide() {
    this.flushDraft()
    this.stopWatching()
    this.hidden = true
    this.hiddenAt = Date.now()
  },

  onUnload() {
    this.flushQueuedIntoDraft()
    this.flushDraft()
    this.saveLast()
    this.stopLiveTicker()
    this.stopWatching()
    this.destroyed = true
    this.imgTasks = {}
    if (this.recorder && this.data.recording) {
      try { this.recorder.stop() } catch (e) { /* ignore */ }
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.followCheckTimer) {
      clearTimeout(this.followCheckTimer)
      this.followCheckTimer = null
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    if (this.draftTimer) {
      clearTimeout(this.draftTimer)
      this.draftTimer = null
    }
    if (this.fsSwitchTimer) {
      clearTimeout(this.fsSwitchTimer)
      this.fsSwitchTimer = null
    }
    if (this.enhanceLockTimer) {
      clearTimeout(this.enhanceLockTimer)
      this.enhanceLockTimer = null
    }
    if (this.gw) {
      this.gw.close()
      this.gw = null
    }
  },

  bindGateway() {
    const gw = new Gateway(this.endpoint, {
      onState: (state) => this.onState(state),
      onOpen: () => {
        this.setData({ errorBanner: '' })
        this.syncSession()
      },
      onEvent: (type, payload, sid, stamp) => this.onEvent(type, payload, sid, stamp),
      onServerRequest: (frame) => this.onServerRequest(frame.id, frame.method, frame.params || {}),
      onRequestCancel: (payload) => this.onRequestCancel(payload),
      onError: (err) => {
        if (this.destroyed) return
        this.setData({ errorBanner: util.errorText(err) })
      },
      onClose: () => {},
      onReopen: () => {
        if (this.destroyed) return
        this.setData({ errorBanner: '' })
        // The old in-memory runtime id is stale after a drop. Resume the stored
        // session before draining queued prompts so no message is lost.
        const resumed = this.syncSession()
        const after = () => this.drainQueue()
        if (resumed && typeof resumed.then === 'function') resumed.then(after, after)
        else after()
      }
    })
    this.gw = gw
    gw.connect().catch((err) => {
      if (this.destroyed) return
      this.setData({ loading: false, errorBanner: util.errorText(err) })
    })
  },

  onState(state) {
    if (this.destroyed) return
    const text = {
      connecting: '连接中',
      open: '已连接',
      reconnecting: '重连中',
      closed: '已断开'
    }
    this.setData({ connState: state, connText: text[state] || state })
  },

  onReconnect() {
    if (!this.gw) return
    this.setData({ errorBanner: '' })
    if (this.gw.isOpen()) {
      // Connecting again is a no-op while open; retry the failed session resume
      // instead, which is what the banner usually reports.
      const resumed = this.syncSession()
      const after = () => this.drainQueue()
      if (resumed && typeof resumed.then === 'function') resumed.then(after, after)
      return
    }
    this.gw.connect().catch((err) => {
      if (this.destroyed) return
      this.setData({ errorBanner: util.errorText(err) })
    })
  },

  syncSession() {
    if (!this.storedId || !this.gw) {
      this.setData({ loading: false })
      return Promise.resolve()
    }
    if (this.syncing) return this.syncing
    // 整体对齐会覆盖正在进行的探测结果，先让旧探测作废。
    this.probeSeq = (this.probeSeq || 0) + 1
    const params = { session_id: this.storedId, inline_images: false }
    if (this.profile) params.profile = this.profile
    this.syncing = this.gw.rpc('session.resume', params, 90000)
      .then((snap) => {
        if (!snap || this.destroyed) return
        this.runtimeId = snap.session_id || this.runtimeId
        this.storedId = snap.stored_session_id || this.storedId
        this.applySnapshot(snap)
        this.setData({ loading: false })
        this.saveLast()
        if (this.renameOnLoad) {
          this.renameOnLoad = false
          this.onDetails()
        }
      })
      .catch((err) => {
        if (this.destroyed) return
        if (err && (err.rpcCode === 4401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          this.setData({ loading: false })
          this.onAuthExpired()
          return
        }
        // A dropped socket during resume is expected; onReopen will retry and
        // the connection bar already explains the state.
        if (err && (err.code === 'WS_CLOSED' || err.code === 'WS_NOT_OPEN')) {
          this.setData({ loading: false })
          return
        }
        this.setData({ loading: false, errorBanner: '载入会话失败：' + util.errorText(err) })
      })
      .then(() => {
        this.syncing = null
      })
    return this.syncing
  },

  // execution_generation 可能出现在快照顶层、info、session 或事件 payload 里，
  // 不同 Hermes 版本的投影位置并不完全一致。
  captureExecGen() {
    for (let i = 0; i < arguments.length; i++) {
      const source = arguments[i]
      if (!source || typeof source !== 'object') continue
      const candidates = [
        source.execution_generation,
        source.info && source.info.execution_generation,
        source.session && source.session.execution_generation,
        source.stamp && source.stamp.execution_generation
      ]
      for (let j = 0; j < candidates.length; j++) {
        const value = candidates[j]
        if (value === undefined || value === null || value === '') continue
        this.execGen = value
        return true
      }
    }
    return false
  },

  hasExecGen() {
    return this.execGen !== null && this.execGen !== undefined && this.execGen !== ''
  },

  applySnapshot(snap) {
    this.captureExecGen(snap, snap.info)
    // resume 成功说明当前令牌可用，之后再次过期允许重新走一次静默续期。
    this.authRecovered = false
    const rawMessages = snap.messages || []
    const msgs = buildMsgs(rawMessages)
    if (rawMessages.length > MAX_ROWS) {
      msgs.unshift({
        id: uid('n'),
        role: 'notice',
        text: '仅显示最近 ' + MAX_ROWS + ' 条消息',
        status: 'done',
        timeText: ''
      })
    }
    const inflight = snap.inflight || null
    const streaming = !!(inflight && inflight.streaming)
    this.turnOpen = streaming
    // 本页没有发起这一回合，说明任务来自其他端：状态要靠快照同步。
    if (!streaming) this.turnLocal = false
    const remoteTurn = streaming && !this.turnLocal
    this.remoteTurn = remoteTurn

    const inflightUser = inflight && inflight.user ? stripSteer(String(inflight.user)) : ''
    const inflightText = inflight ? String(inflight.assistant || '') : ''
    const inflightReasoning = inflight ? rowReasoning(inflight) : ''
    const inflightActive = !!(inflight && (inflightText || inflightReasoning || inflight.streaming))

    let lastUser = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser = i
        break
      }
    }

    // 用户输入在服务端通常是先落库再开始执行，所以历史里往往已经有这条
    // 用户行，而且后面还跟着工具 / 半截回复。只比较「最后一条消息」会在
    // 这种快照上再补一条相同的用户气泡，重新进入会话就出现两条相同输入。
    const userInHistory = lastUser >= 0 && samePromptText(msgs[lastUser].text, inflightUser)
    if (inflightUser && !userInHistory) {
      msgs.push({
        id: uid('u'),
        role: 'user',
        text: inflightUser,
        images: [],
        files: [],
        status: 'done',
        timeText: util.formatTime(Date.now())
      })
      lastUser = msgs.length - 1
    }

    if (inflightActive) {
      // 已经落库的半截回复继续写回原气泡，避免同一条输出再出现一份。
      let reuse = null
      for (let i = msgs.length - 1; i > lastUser; i--) {
        if (msgs[i].role === 'assistant') {
          reuse = msgs[i]
          break
        }
      }
      // 同一轮里落库的空壳（工具锚点 / 仅思考）也可以直接续写。
      const reusable = !!(reuse && (
        (inflightText && sameOrPrefix(reuse.text, inflightText)) ||
        !String(reuse.text || '').trim()
      ))

      let msg = null
      if (reusable) {
        msg = reuse
        if (inflightText && inflightText.length >= String(msg.text || '').length) msg.text = inflightText
        if (inflightReasoning && inflightReasoning.length >= String(msg.reasoning || '').length) {
          msg.reasoning = inflightReasoning
        }
        msg.status = streaming ? 'streaming' : (inflight.error ? 'error' : 'done')
      } else {
        msg = assistantMsg({
          text: inflightText,
          // 断线重进时服务端会把已产出的思考带上，补回气泡里。
          reasoning: inflightReasoning,
          model: this.modelCurrent || '',
          status: streaming ? 'streaming' : (inflight.error ? 'error' : 'done'),
          timeText: util.formatTime(Date.now())
        })
        msgs.push(msg)
      }

      if (streaming) {
        this.turnStartAt = Date.now()
        // 续写已有气泡时，实时视图要能从恢复的思考 / 工具继续展开。
        if (msg.reasoning || (msg.tools && msg.tools.length)) {
          msg.steps = [{
            key: 's0',
            think: msg.reasoning || '',
            tools: (msg.tools || []).slice(),
            show: true
          }]
        }
        this.streamMsgId = msg.id
      } else {
        this.streamMsgId = ''
      }
    } else {
      this.streamMsgId = ''
    }

    msgs.forEach((msg) => this.decorate(msg))
    this.msgs = msgs
    this.dirty = {}
    this.retagTurns()

    const info = snap.info || {}
    if (info.model) this.setModelInfo(info.model)
    if (info.cwd && info.cwd !== this.cwd) {
      this.cwd = info.cwd
      this.applyMeta()
    }
    const title = info.title || this.title || ''
    if (title) this.setTitle(title)

    let usageText = this.data.usageText
    if (info.usage && info.usage.total) usageText = '上下文 ' + info.usage.total + ' tokens'

    this.setData({
      msgs: msgs,
      streaming: streaming,
      remoteTurn: remoteTurn,
      liveDetail: !!this.liveDetail,
      sending: false,
      statusText: '',
      usageText: usageText
    })
    this.syncLive()
    this.scrollToBottom()
    this.idleProbeAt = Date.now()

    this.approvalActive = false
    this.clarifyActive = false
    this.secretActive = false
    const open = snap.open_requests || []
    open.forEach((req) => {
      this.onServerRequest(req.id, req.method, req.params || {})
    })
    if (!this.approvalActive && snap.pending_approval) {
      this.showApproval(snap.pending_approval, null)
    }
    if (!streaming) {
      this.turnSeq = (this.turnSeq || 0) + 1
      this.drainQueue()
    }
  },

  mdStyles() {
    const p = theme.palette()
    return {
      text: p.text,
      dim: p.dim,
      mute: p.mute,
      accent: p.accent,
      accentSoft: p.accentSoft,
      link: p.link,
      codeBg: p.codeBg,
      codeText: p.codeText,
      border: p.border,
      surface2: p.surface2,
      ok: p.ok,
      tableWidth: tableAvailWidth()
    }
  },

  decorate(msg) {
    if (!msg || msg.role !== 'assistant') return
    if (!msg.text || msg.status === 'streaming') {
      msg.blocks = []
      if (!this.imageTaskOf(msg)) {
        msg.mdImages = []
        msg.fileCards = []
      }
      return
    }
    const out = markdown.render(msg.text, this.mdStyles())
    msg.blocks = out.blocks || []
    // Markdown rendering produces new image objects. Reuse the cached temp-file
    // path so switching themes does not re-download every image, and keep the
    // current array intact while a load worker is running.
    if (!this.imageTaskOf(msg)) {
      const previous = {}
      ;(msg.mdImages || []).forEach((img) => {
        if (img && img.raw) previous[img.raw] = img
      })
      msg.mdImages = (out.images || []).map((img, i) => {
        const src = String(img.src || '')
        const old = previous[src]
        let displaySrc = ''
        if (/^data:/i.test(src) || /^https?:/i.test(src)) displaySrc = src
        else displaySrc = serverAssetUrl(this.endpoint, src)
        if (!displaySrc && old && old.displaySrc) displaySrc = old.displaySrc
        return {
          key: 'img' + i,
          alt: img.alt,
          raw: img.src,
          name: markdown.baseName(src) || img.alt || '图片',
          displaySrc: displaySrc,
          filePath: old && old.filePath ? old.filePath : (files.isLocalPath(displaySrc) ? displaySrc : ''),
          pending: !displaySrc && !(old && old.failed),
          started: !!(old && old.started),
          failed: !!(old && old.failed),
          error: old && old.error ? old.error : ''
        }
      })
    }
    msg.fileCards = (out.files || []).map((file, i) => {
      const raw = String(file.path || '')
      const external = /^https?:/i.test(raw)
      const abs = external ? raw : files.absolute(raw, this.cwd)
      return {
        key: 'fc' + i,
        name: file.name || markdown.baseName(raw),
        path: raw,
        abs: abs,
        dir: external ? '' : files.parentPath(abs),
        ext: file.ext || markdown.extOf(raw),
        external: external
      }
    })
    if ((msg.mdImages || []).some((img) => img.pending)) this.resolveImages(msg)
  },

  imageTaskOf(msg) {
    if (!msg || !msg.id || !this.imgTasks) return null
    return this.imgTasks[msg.id] || null
  },

  resolveImages(msg, retryFailed) {
    if (!this.endpoint) return null
    const running = this.imageTaskOf(msg)
    if (running) return running
    const targets = (msg.mdImages || []).filter((img) => {
      if (!img || img.displaySrc) return false
      if (retryFailed) return img.failed || !img.started
      return !img.started && !img.failed
    })
    if (!targets.length) return null
    targets.forEach((img) => {
      img.started = true
      img.pending = true
      img.failed = false
      img.error = ''
    })

    let cursor = 0
    const runNext = () => {
      if (cursor >= targets.length || this.destroyed) return Promise.resolve()
      const img = targets[cursor]
      cursor += 1
      const path = files.absolute(img.raw, this.cwd)
      return files.readImageFile(this.endpoint, path, this.profile)
        .then((filePath) => {
          img.filePath = filePath
          img.displaySrc = filePath
          img.pending = false
        })
        .catch((err) => {
          img.pending = false
          img.failed = true
          img.error = util.errorText(err)
          if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
            this.onAuthExpired()
          }
        })
        .then(runNext)
    }

    const workers = []
    const concurrency = Math.min(2, targets.length)
    for (let i = 0; i < concurrency; i++) workers.push(runNext())
    this.imgTasks = this.imgTasks || {}
    const task = Promise.all(workers).then(() => {
      if (this.imgTasks) delete this.imgTasks[msg.id]
      if (this.destroyed) return
      const index = this.msgs.indexOf(msg)
      if (index < 0) return
      this.setData({ ['msgs[' + index + '].mdImages']: msg.mdImages.slice() })
    })
    this.imgTasks[msg.id] = task
    return task
  },

  rebuildRich() {
    ;(this.msgs || []).forEach((msg) => this.decorate(msg))
    this.dirty = {}
    this.setData({ msgs: this.msgs.slice() })
  },

  // ── meta ───────────────────────────────────────────────────────────

  loadMeta() {
    if (!this.endpoint || this.metaLoading) return Promise.resolve()
    this.metaLoading = true
    return sessionops.list(this.endpoint, this.profile, 100)
      .then((body) => {
        this.metaLoading = false
        if (this.destroyed) return
        let row = null
        ;(body.sessions || []).some((item) => {
          if (item.id === this.storedId) {
            row = item
            return true
          }
          return false
        })
        if (row) {
          this.metaRow = row
          if (!this.cwd && row.cwd) this.cwd = row.cwd
          if (!this.title && row.title) this.setTitle(row.title)
          this.applyMeta()
          this.saveLast()
        } else if (!this.cwd) {
          return this.loadDefaultCwd()
        }
      })
      .catch((err) => {
        this.metaLoading = false
        if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          this.onAuthExpired()
        }
      })
  },

  loadDefaultCwd() {
    if (!this.endpoint || this.defaultCwdTried) return Promise.resolve()
    this.defaultCwdTried = true
    return files.defaultCwd(this.endpoint, this.profile)
      .then((body) => {
        if (this.destroyed) return
        if (!this.cwd && body && body.cwd) {
          this.cwd = body.cwd
          this.applyMeta()
        }
      })
      .catch(() => {})
  },

  applyMeta() {
    if (!this.endpoint) return
    const row = this.metaRow || {}
    const source = row.source || 'local'
    const channel = workspaces.channelOf(source)
    const info = workspaces.channelInfo(channel)
    const model = this.pendingModel || this.modelCurrent || row.model || ''
    this.setData({
      wsName: this.cwd ? workspaces.workspaceName(this.cwd) : '默认工作区',
      wsShort: workspaces.shortPath(this.cwd),
      modelLabel: model,
      modelShort: shortModel(model),
      channelLabel: info.label,
      channelClass: info.id
    })
  },

  setModelInfo(model) {
    const id = String(model || '')
    if (!id) return
    this.modelCurrent = id
    if (this.metaRow) this.metaRow.model = id
    if (this.data.modelLabel === id && this.data.modelShort) return
    this.setData({ modelLabel: id, modelShort: shortModel(id) }, () => {
      if (this.data.modelOpen && this.data.modelProviders.length) this.buildModelList()
    })
  },

  setTitle(title) {
    if (!title || this.title === title) return
    this.title = title
    this.setData({ title: title })
    this.saveLast()
  },

  saveLast() {
    if (!this.endpoint || !this.storedId) return
    last.set(this.endpoint.id, {
      id: this.storedId,
      title: this.title,
      cwd: this.cwd,
      profile: this.profile
    })
  },

  // ── stream events ──────────────────────────────────────────────────

  finalizeStream(status, fallbackText) {
    const msg = this.currentStream()
    this.streamMsgId = ''
    this.turnOpen = false
    this.turnLocal = false
    this.remoteTurn = false
    if (!msg) {
      this.settleStreams(null)
      this.dirty = {}
      this.retagTurns()
      this.setData({ msgs: this.msgs.slice(), streaming: false, sending: false, statusText: '', remoteTurn: false })
      this.syncLive()
      return null
    }
    msg.status = status
    if (!msg.text && fallbackText) msg.text = fallbackText
    this.decorate(msg)
    this.settleStreams(msg)
    this.dirty = {}
    this.retagTurns()
    this.setData({
      msgs: this.msgs.slice(),
      streaming: false,
      sending: false,
      statusText: '',
      remoteTurn: false
    })
    this.syncLive()
    return msg
  },

  // 收尾时把本轮所有仍处于 streaming 的气泡一起结束。服务端的事件顺序
  // 偶尔会让旧气泡停在「生成中」，那样已完成的回合会一直按实时态展开，
  // 看起来就像没有折叠的历史气泡。
  settleStreams(keep) {
    if (!this.msgs || !this.msgs.length) return
    const next = []
    this.msgs.forEach((item) => {
      if (item.role !== 'assistant') {
        next.push(item)
        return
      }
      // 回合已经结束，不可能还有工具在跑；否则收起后的工具行会一直转圈。
      ;(item.tools || []).forEach((tool) => {
        if (!tool.done) tool.done = true
      })
      if (item === keep || item.status !== 'streaming') {
        next.push(item)
        return
      }
      item.status = 'done'
      if (!item.text && !item.reasoning && !(item.tools && item.tools.length)) return
      this.decorate(item)
      next.push(item)
    })
    if (next.length !== this.msgs.length) this.msgs = next
  },

  // ── live status bar (结果优先模式) ──────────────────────────────────

  liveStep() {
    if (!this.flowMode || !this.data.streaming) return null
    const msg = this.currentStream()
    const tools = (msg && msg.tools) || []
    const remote = !!this.remoteTurn
    let running = null
    for (let i = tools.length - 1; i >= 0; i--) {
      if (!tools[i].done) {
        running = tools[i]
        break
      }
    }
    const elapsed = this.turnStartAt ? Math.round((Date.now() - this.turnStartAt) / 1000) : 0
    const time = elapsed >= 1 ? elapsed + 's' : ''
    const status = this.data.statusText || ''
    if (running) {
      return {
        icon: 'refresh',
        title: '正在执行 ' + (running.name || '工具'),
        sub: running.context ? cut(running.context, 80) : status,
        step: '第 ' + tools.length + ' 步',
        time: time,
        remote: remote
      }
    }
    if (msg && msg.text) {
      return { icon: 'arrow-up', title: '正在输出结果', sub: status, step: '', time: time, remote: remote }
    }
    if (msg && msg.reasoning) {
      return { icon: 'info', title: '正在思考', sub: tailLine(msg.reasoning, 80), step: '', time: time, remote: remote }
    }
    return { icon: 'info', title: '正在准备', sub: status, step: '', time: time, remote: remote }
  },

  refreshLive() {
    if (this.destroyed) return
    const next = this.liveStep()
    const sig = next ? [next.icon, next.title, next.sub, next.step, next.time, next.remote].join('|') : ''
    if (sig === this.liveSig) return
    const wasVisible = !!this.data.liveStatus
    this.liveSig = sig
    this.setData({ liveStatus: next })
    // 状态栏出现/消失会改变列表可视高度，重新量一次以保持自动跟随判断准确。
    if (wasVisible !== !!next) this.measureThreadViewport()
  },

  startLiveTicker() {
    if (this.liveTimer || this.destroyed || !this.flowMode) return
    this.liveTimer = setInterval(() => this.refreshLive(), 1000)
  },

  stopLiveTicker() {
    if (!this.liveTimer) return
    clearInterval(this.liveTimer)
    this.liveTimer = null
  },

  // 单处收口：两种模式的实时表现只在这里分叉，避免切换后状态残留。
  syncLive() {
    if (this.destroyed) return
    this.syncWatcher()
    if (!this.flowMode || !this.data.streaming) {
      this.stopLiveTicker()
      const patch = {}
      if (this.liveSig || this.data.liveStatus) {
        if (this.data.liveStatus) this.measureThreadViewport()
        this.liveSig = ''
        patch.liveStatus = null
      }
      // 详情/收起由用户选择并记住，这里不再自动切回简述。
      if (Object.keys(patch).length) this.setData(patch)
      return
    }
    this.startLiveTicker()
    this.refreshLive()
  },

  // ── 跨端状态同步 ────────────────────────────────────────────────────

  // 其他端发起的回合不会有本机事件，只能按快照补齐；有事件时轮询自动让位。
  syncWatcher() {
    if (this.destroyed || this.hidden || !this.storedId) {
      this.stopWatching()
      return
    }
    if (this.watching) return
    this.watching = true
    this.watchTimer = setInterval(() => this.probeSession(false), REMOTE_POLL_MS)
    if (!this.data.streaming) this.probeSession(false)
  },

  startWatching() {
    if (this.watching) return
    this.hidden = false
    this.syncWatcher()
  },

  stopWatching() {
    this.watching = false
    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = null
    }
  },

  probeSession(force) {
    if (this.destroyed || this.hidden || !this.storedId) return Promise.resolve()
    if (!this.gw || !this.gw.isOpen() || this.syncing || this.probing) return this.probing || Promise.resolve()
    // 首次提交还没拿到 ACK 时，服务端快照里可能还看不到这一回合，
    // 用它覆盖会把刚发出的气泡抹掉。
    if (this.data.sending && !this.data.streaming) return Promise.resolve()
    const streaming = !!this.data.streaming
    // 其他端的回合没有本机事件，需要更积极地补读；本机回合以事件为主。
    const grace = this.turnLocal ? LOCAL_EVENT_GRACE_MS : REMOTE_EVENT_GRACE_MS
    if (streaming && !force && Date.now() - (this.lastEventAt || 0) < grace) {
      // 实时事件正在流动，快照反而可能落后，跳过这一轮。
      return Promise.resolve()
    }
    if (!streaming && !force && !this.needsIdleProbe()) return Promise.resolve()
    const params = { session_id: this.storedId, inline_images: false }
    if (this.profile) params.profile = this.profile
    const seq = (this.probeSeq || 0) + 1
    this.probeSeq = seq
    this.idleProbeAt = Date.now()
    this.probing = this.gw.rpc('session.resume', params, 25000)
      .then((snap) => {
        this.probing = null
        if (this.destroyed || seq !== this.probeSeq || !snap) return
        this.applyProbe(snap)
      })
      .catch(() => {
        this.probing = null
      })
    return this.probing
  },

  // 空闲探测没有必要每次都对整个列表做一次重建。
  needsIdleProbe() {
    if (this.data.sending || this.draining) return false
    const now = Date.now()
    if (!this.idleProbeAt) return true
    return now - this.idleProbeAt >= REMOTE_IDLE_POLL_MS
  },

  // 把快照合并进当前视图：只更新正在执行的气泡，回合结束才整体对齐。
  applyProbe(snap) {
    if (!snap) return
    this.captureExecGen(snap, snap.info)
    if (snap.session_id) this.runtimeId = snap.session_id || this.runtimeId
    if (snap.stored_session_id) this.storedId = snap.stored_session_id || this.storedId
    const inflight = snap.inflight || null
    const streaming = !!(inflight && inflight.streaming)
    this.idleProbeAt = Date.now()

    // 提交请求在途时快照还没有这一回合，别用它覆盖本地刚发出的内容。
    if (this.data.sending && !streaming) return
    if (!streaming && !this.data.streaming) return
    if (!streaming) {
      // 本页刚发起的回合可能还没进入服务端快照，别把它当成「已结束」抹掉。
      if (this.turnLocal && Date.now() - (this.localTurnAt || 0) < 12000) return
      if (this.turnLocal) {
        // 本机回合以事件为准；快照连续两次都说结束才整体对齐，避免中途的
        // 空 inflight 把正在跑的回合提前收尾。
        this.probeEndHits = (this.probeEndHits || 0) + 1
        if (this.probeEndHits < 2) return
      }
      this.probeEndHits = 0
      // 回合在别处结束：完整对齐一次，拿到落库后的最终内容。
      this.applySnapshot(snap)
      return
    }
    this.probeEndHits = 0
    if (!this.data.streaming) {
      // 其他端刚发起一个新回合：一次性对齐，拿到用户输入与上下文。
      this.applySnapshot(snap)
      return
    }
    this.mergeInflight(inflight, snap.info)
  },

  mergeInflight(inflight, info) {
    if (!inflight) return
    const rawUser = inflight.user ? String(inflight.user) : ''
    const userText = rawUser ? stripSteer(rawUser) : ''
    const text = inflight.assistant ? String(inflight.assistant) : ''
    const reasoning = rowReasoning(inflight)

    // 用户气泡可能已经由历史或本地乐观插入带来，只在最近几条里补缺失的一条，
    // 避免轮询把同一句输入重复加到会话里。
    if (userText && !this.recentUserHas(userText)) {
      this.pushUser(userText, [], [], false, rawUser.indexOf(STEER_OPEN) >= 0)
    }

    let msg = this.currentStream()
    let created = false
    if (!msg) {
      msg = assistantMsg({
        model: this.modelCurrent || this.data.modelLabel || '',
        status: 'streaming',
        timeText: util.formatTime(Date.now())
      })
      this.msgs.push(msg)
      this.streamMsgId = msg.id
      created = true
    }

    let changed = false
    if (text && text.length > String(msg.text || '').length) {
      msg.text = text
      changed = true
    }
    if (reasoning && reasoning.length > String(msg.reasoning || '').length) {
      msg.reasoning = reasoning
      let step = this.stepTail(msg)
      if (!step) step = this.beginStep(msg)
      step.think = reasoning
      changed = true
    }
    if (changed) {
      msg.status = 'streaming'
      this.markDirty(msg.id)
      this.settleSteps(msg)
    }
    if (!this.turnStartAt) this.turnStartAt = Date.now()
    this.turnOpen = true
    this.remoteTurn = !this.turnLocal
    if (created) {
      this.setData({ msgs: this.msgs.slice(), streaming: true, remoteTurn: this.remoteTurn })
    } else if (!this.data.streaming) {
      this.setData({ streaming: true, remoteTurn: this.remoteTurn })
    }
    if (info && info.model) this.setModelInfo(info.model)
    this.syncLive()
    this.scrollToBottom()
  },

  recentUserHas(text) {
    if (!text) return false
    const from = Math.max(0, this.msgs.length - 12)
    for (let i = this.msgs.length - 1; i >= from; i--) {
      const item = this.msgs[i]
      if (item.role === 'user' && samePromptText(item.text, text)) return true
    }
    return false
  },

  // 执行中在「简述」与「实时详情」之间切换：详情把当前气泡的思考与工具调用
  // 展开在气泡内，收起即回到只保留输出正文的简述视图。
  onToggleLiveDetail() {
    if (!this.flowMode || !this.data.streaming) return
    const next = !this.data.liveDetail
    this.liveDetail = next
    if (this.endpoint) writeLiveDetail(this.endpoint.id, this.storedId, next)
    this.setData({ liveDetail: next })
    if (this.streamMsgId) this.markDirty(this.streamMsgId)
    try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* ignore */ }
  },

  // 手动回看某一小步；下一次产生新步骤时它会被自动收起
  onToggleStep(e) {
    const id = e.currentTarget.dataset.id
    const si = Number(e.currentTarget.dataset.index)
    const i = this.msgIndex(id)
    if (i < 0) return
    const msg = this.msgs[i]
    const step = msg.steps && msg.steps[si]
    if (!step) return
    step.show = !step.show
    this.setData({ ['msgs[' + i + '].steps[' + si + '].show']: step.show })
  },

  onEvent(type, payload, sid, stamp) {
    if (this.destroyed) return
    // 服务端可能用 runtime id 或落库 id 标注会话；两个都认，避免把其他端
    // 同一会话的事件误当成别人的而丢弃。会话 id 还没拿到时先照收。
    const knownSid = this.runtimeId || this.storedId
    if (sid && knownSid && sid !== this.runtimeId && sid !== this.storedId) return
    this.lastEventAt = Date.now()
    this.probeEndHits = 0
    this.captureExecGen(stamp, payload)
    switch (type) {
      case 'message.start':
        this.beginStream()
        break
      case 'message.delta':
        // 少数实现把思考混在 message.delta 里，用 type 区分，不能写进正文。
        if (payload && /reason|think/i.test(String(payload.type || ''))) {
          this.appendReasoning(payloadReasoning(payload))
        } else {
          this.appendDelta(payload && payload.text)
        }
        break
      case 'message.interim':
        this.onInterim(payload || {})
        break
      case 'message.complete':
        this.completeTurn(payload || {})
        break
      case 'reasoning.delta':
      case 'thinking.delta':
        this.appendReasoning(payloadReasoning(payload))
        break
      case 'tool.start':
        this.toolStart(payload || {})
        break
      case 'tool.complete':
        this.toolComplete(payload || {})
        break
      case 'session.title':
        if (payload && payload.title) this.setTitle(payload.title)
        break
      case 'session.info':
        this.onInfo(payload || {})
        break
      case 'session.usage':
        this.showUsage(payload && payload.usage)
        break
      case 'status.update':
        if (payload && payload.text) {
          this.setData({ statusText: payload.text })
          this.refreshLive()
        }
        break
      case 'error': {
        const message = (payload && payload.message) || '未知错误'
        this.turnSeq = (this.turnSeq || 0) + 1
        // Close the current bubble before the next turn starts; otherwise
        // beginStream() would reuse a bubble that still says "生成中".
        this.finalizeStream('error', '执行失败：' + message)
        this.addNotice('错误：' + message, 'error')
        this.drainQueue()
        break
      }
      default:
        break
    }
  },

  onInfo(info) {
    this.captureExecGen(info)
    if (info.title) this.setTitle(info.title)
    if (info.model) this.setModelInfo(info.model)
    if (info.stored_session_id) {
      this.storedId = info.stored_session_id
      this.saveLast()
      // 新会话建立后才有 id，把本轮已经做出的详情/收起选择补记到该会话。
      if (this.liveDetail) writeLiveDetail(this.endpoint.id, this.storedId, true)
    }
    if (info.cwd && info.cwd !== this.cwd) {
      this.cwd = info.cwd
      this.applyMeta()
    }
    if (info.running) {
      if (!this.turnStartAt) this.turnStartAt = Date.now()
      this.turnOpen = true
      this.remoteTurn = !this.turnLocal
      this.setData({ streaming: true, remoteTurn: this.remoteTurn })
      this.syncLive()
    } else if (info.running === false && !this.streamMsgId && !this.data.sending) {
      // 服务端已明确表示没有正在执行的回合：清掉本地的输出中状态，
      // 否则状态栏和模式切换锁会一直停在「输出中」。
      this.turnOpen = false
      this.turnLocal = false
      this.remoteTurn = false
      if (this.data.streaming) {
        this.setData({ streaming: false, remoteTurn: false })
        this.syncLive()
      }
    }
    if (info.usage) this.showUsage(info.usage)
  },

  showUsage(usage) {
    if (!usage) return
    const total = usage.total || usage.total_tokens
    if (total) this.setData({ usageText: '上下文 ' + total + ' tokens' })
  },

  findMsg(id) {
    for (let i = 0; i < this.msgs.length; i++) {
      if (this.msgs[i].id === id) return this.msgs[i]
    }
    return null
  },

  currentStream() {
    return this.streamMsgId ? this.findMsg(this.streamMsgId) : null
  },

  beginStream() {
    const current = this.currentStream()
    if (current && current.status === 'streaming') return current
    const msg = assistantMsg({
      model: this.modelCurrent || this.data.modelLabel || '',
      status: 'streaming',
      timeText: util.formatTime(Date.now())
    })
    this.turnStartAt = Date.now()
    this.turnOpen = true
    this.remoteTurn = !this.turnLocal
    this.msgs.push(msg)
    this.streamMsgId = msg.id
    // 沿用用户记住的详情/收起选择，不再每轮强制展开。
    this.setData({
      msgs: this.msgs.slice(),
      streaming: true,
      remoteTurn: this.remoteTurn,
      statusText: '',
      liveDetail: !!this.liveDetail
    })
    this.syncLive()
    this.scrollToBottom()
    return msg
  },

  ensureStream() {
    return this.currentStream() || this.beginStream()
  },

  // 回合结束后可能还会收到迟到的 delta / tool 事件；没有新的发送或开始
  // 事件时不能让它再开一个「生成中」气泡，否则会留下不会折叠的尾巴。
  acceptStreamEvent() {
    return !!(this.turnOpen || this.data.streaming || this.data.sending)
  },

  appendDelta(text) {
    if (!text || !this.acceptStreamEvent()) return
    const msg = this.ensureStream()
    msg.text += text
    msg.status = 'streaming'
    this.settleSteps(msg)
    if (!this.data.streaming) this.setData({ streaming: true })
    this.markDirty(msg.id)
  },

  // 正文开始输出，说明这一步的思考与工具都已结束：自动收起，把视线让给新内容。
  settleSteps(msg) {
    const last = this.stepTail(msg)
    if (!last || !last.show) return
    if ((last.tools || []).some((tool) => !tool.done)) return
    last.show = false
  },

  stepTail(msg) {
    if (!msg.steps) msg.steps = []
    return msg.steps.length ? msg.steps[msg.steps.length - 1] : null
  },

  // 新的一步自动展开，之前的步骤随即收起，保证同一时刻只看当前进行中的内容。
  beginStep(msg) {
    msg.steps.forEach((step) => { step.show = false })
    const step = { key: 'st' + msg.steps.length, think: '', tools: [], show: true }
    msg.steps.push(step)
    return step
  },

  // 思考：上一步已经调用过工具就另起一步，保证每次思考单独成泡、不合并堆叠。
  thinkingStep(msg) {
    const last = this.stepTail(msg)
    if (last && !last.tools.length) {
      last.show = true
      return last
    }
    return this.beginStep(msg)
  },

  // 工具：归入最近一次思考所在的步骤；没有步骤时补一个空思考的步骤。
  toolStep(msg) {
    const last = this.stepTail(msg)
    if (last) {
      last.show = true
      return last
    }
    return this.beginStep(msg)
  },

  appendReasoning(text) {
    if (!text || !this.acceptStreamEvent()) return
    const msg = this.ensureStream()
    msg.reasoning += text
    this.thinkingStep(msg).think += text
    this.markDirty(msg.id)
  },

  onInterim(payload) {
    const text = payload.text
    if (!text || payload.already_streamed || !this.acceptStreamEvent()) return
    const msg = this.ensureStream()
    if (this.flowMode) {
      // 结果优先模式下一轮只保留一个输出气泡：分段输出就地合并，不再逐段
      // 开新气泡向上滚动；最终以 message.complete 的全文为准。
      const current = String(msg.text || '')
      let merged = current
      if (!current) merged = text
      else if (text.indexOf(current) === 0) merged = text
      else if (current.indexOf(text) >= 0) merged = current
      else merged = current.replace(/\s+$/, '') + '\n\n' + text
      if (merged !== current) {
        msg.text = merged
        msg.status = 'streaming'
        this.settleSteps(msg)
        this.markDirty(msg.id)
      }
      return
    }
    if (msg.text) {
      msg.status = 'done'
      this.decorate(msg)
      this.markDirty(msg.id)
      this.streamMsgId = ''
    }
    const next = this.ensureStream()
    next.text = text
    this.markDirty(next.id)
  },

  toolStart(payload) {
    if (!this.acceptStreamEvent()) return
    const msg = this.ensureStream()
    const id = payload.tool_id || uid('t')
    for (let i = 0; i < msg.tools.length; i++) {
      if (msg.tools[i].id === id) return
    }
    const tool = {
      id: id,
      name: payload.name || 'tool',
      context: payload.context || '',
      summary: '',
      done: false,
      durationText: ''
    }
    msg.tools.push(tool)
    // 与触发它的那次思考配成一组；同一段思考连续调用的工具归在同一组里。
    this.toolStep(msg).tools.push(tool)
    this.markDirty(msg.id)
  },

  toolComplete(payload) {
    const id = payload.tool_id || ''
    let owner = null
    for (let i = 0; i < this.msgs.length && !owner; i++) {
      const tools = this.msgs[i].tools || []
      for (let j = 0; j < tools.length; j++) {
        if (tools[j].id === id) {
          owner = this.msgs[i]
          break
        }
      }
    }
    // 已有归属的工具补完仍然处理（只更新旧气泡），没有归属又不在输出中
    // 的事件则丢弃，避免凭空生成一个不会收尾的气泡。
    if (!owner && !this.acceptStreamEvent()) return
    const msg = owner || this.ensureStream()
    let tool = null
    for (let i = 0; i < msg.tools.length; i++) {
      if (msg.tools[i].id === id) {
        tool = msg.tools[i]
        break
      }
    }
    if (!tool) {
      tool = { id: id || uid('t'), name: payload.name || 'tool', context: payload.context || '', summary: '', done: true, durationText: '' }
      msg.tools.push(tool)
      this.toolStep(msg).tools.push(tool)
    }
    tool.done = true
    tool.name = payload.name || tool.name
    if (payload.summary) tool.summary = payload.summary
    else if (!tool.summary) {
      const result = payload.result
      tool.summary = cut(typeof result === 'string' ? result : JSON.stringify(result || ''), 140)
    }
    if (payload.duration_s) tool.durationText = Number(payload.duration_s).toFixed(1) + 's'
    this.markDirty(msg.id)
  },

  completeTurn(payload) {
    this.turnSeq = (this.turnSeq || 0) + 1
    const isError = payload.status === 'error' || payload.status === 'failed'
    let msg = this.currentStream()
    if (!msg && isError) {
      // An error event may have already closed the bubble and appended a notice;
      // scan back to that bubble instead of minting a second failed message.
      for (let i = this.msgs.length - 1; i >= 0; i--) {
        const item = this.msgs[i]
        if (item.role === 'user') break
        if (item.role === 'assistant') {
          if (item.status === 'error') msg = item
          break
        }
      }
    }
    if (!msg) msg = this.ensureStream()
    if (!msg.model) msg.model = this.modelCurrent || this.data.modelLabel || ''
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text) {
      if (!msg.text) {
        msg.text = text
      } else if (msg.text.indexOf(text) < 0 && text.indexOf(msg.text) < 0) {
        msg.text = text
      } else if (msg.text.length < text.length) {
        msg.text = text
      }
    }
    const finalReasoning = rowReasoning(payload)
    if (finalReasoning && !msg.reasoning) msg.reasoning = finalReasoning
    if (payload.status === 'error' || payload.status === 'failed') {
      msg.status = 'error'
      if (!msg.text) msg.text = payload.warning || '本轮执行失败'
    } else {
      msg.status = 'done'
    }
    this.streamMsgId = ''
    this.turnOpen = false
    if (!msg.text && !msg.reasoning && !msg.tools.length) {
      const idx = this.msgs.indexOf(msg)
      if (idx >= 0) this.msgs.splice(idx, 1)
    } else {
      this.decorate(msg)
    }
    this.settleStreams(msg)
    this.dirty = {}
    this.retagTurns()
    this.turnLocal = false
    this.remoteTurn = false
    this.setData({
      msgs: this.msgs.slice(),
      streaming: false,
      sending: false,
      statusText: '',
      remoteTurn: false
    })
    this.syncLive()
    if (payload.usage) this.showUsage(payload.usage)
    this.scrollToBottom()
    this.drainQueue()
  },

  markDirty(id) {
    this.dirty[id] = true
    this.scheduleFlush()
  },

  scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_MS)
  },

  flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  },

  flush() {
    const ids = Object.keys(this.dirty)
    this.dirty = {}
    if (!ids.length || this.destroyed) return
    const patch = {}
    ids.forEach((id) => {
      let idx = -1
      for (let i = 0; i < this.msgs.length; i++) {
        if (this.msgs[i].id === id) {
          idx = i
          break
        }
      }
      if (idx < 0) return
      const msg = this.msgs[idx]
      const base = 'msgs[' + idx + ']'
      const live = msg.status === 'streaming'
      patch[base + '.text'] = msg.text
      patch[base + '.status'] = msg.status
      if (!live || !this.flowMode || this.data.liveDetail) {
        // 结果优先模式的简述视图不渲染进行中的过程内容；用户点开实时详情后
        // 才按帧同步思考与工具调用。
        patch[base + '.reasoning'] = msg.reasoning
        patch[base + '.tools'] = msg.tools
        if (live) patch[base + '.steps'] = msg.steps
      }
      if (!live) {
        // While streaming, blocks/mdImages are empty; sending them every 60ms
        // only inflates the setData payload. They are flushed once on complete.
        patch[base + '.blocks'] = msg.blocks || []
        patch[base + '.mdImages'] = msg.mdImages || []
        patch[base + '.fileCards'] = msg.fileCards || []
        patch[base + '.timeText'] = msg.timeText
      }
    })
    if (this.canAutoFollow()) {
      this.armFollowScroll()
      this.anchorFlip = !this.anchorFlip
      patch.anchorId = this.anchorFlip ? 'anchorB' : 'anchorA'
    }
    this.setData(patch)
    this.syncLive()
  },

  canAutoFollow() {
    return this.autoFollow && !this.userTouching
  },

  armFollowScroll(ms) {
    this.followScrollPending = true
    this.followScrollPendingUntil = Date.now() + (ms || SCROLL_SETTLE_MS)
  },

  setAutoFollow(next) {
    if (this.autoFollow === next) return
    this.autoFollow = next
    if (!next) this.followScrollPending = false
    this.setData({ showScrollDown: !next })
  },

  scrollToBottom(force) {
    if (this.destroyed) return
    if (!force && !this.canAutoFollow()) return
    const patch = {}
    if (!this.autoFollow) {
      this.autoFollow = true
      patch.showScrollDown = false
    }
    this.armFollowScroll()
    this.anchorFlip = !this.anchorFlip
    patch.anchorId = this.anchorFlip ? 'anchorB' : 'anchorA'
    this.setData(patch)
  },

  measureThreadViewport() {
    if (this.destroyed || this.measurePending) return
    this.measurePending = true
    wx.createSelectorQuery().in(this).select('.thread').boundingClientRect((rect) => {
      this.measurePending = false
      if (this.destroyed || !rect || !rect.height) return
      const changed = Math.abs(rect.height - this.threadViewportHeight) > 1
      this.threadViewportHeight = rect.height
      if (changed) this.scheduleFollowCheck()
    }).exec()
  },

  // Leading + trailing throttle: the first scroll event reacts immediately,
  // continuous momentum updates settle at most once per SCROLL_CHECK_MS.
  scheduleFollowCheck() {
    if (this.destroyed || this.followCheckTimer) return
    this.evaluateFollowState()
    this.followCheckTimer = setTimeout(() => {
      this.followCheckTimer = null
      if (!this.destroyed) this.evaluateFollowState()
    }, SCROLL_CHECK_MS)
  },

  // 只有「主动向下滑到接近底部」才恢复跟随；这里只改状态、不做任何滚动，
  // 避免在用户滑动过程中把列表拽走。真正吸底仍由内容追加时的 flush 触发。
  evaluateFollowState() {
    if (this.destroyed) return
    const viewport = this.threadViewportHeight
    const height = this.lastScrollHeight
    if (!viewport || !height) return
    const gap = Math.max(0, height - this.lastScrollTop - viewport)

    if (this.followScrollPending) {
      if (gap <= SCROLL_RESUME_GAP || Date.now() >= this.followScrollPendingUntil) {
        this.followScrollPending = false
      } else {
        return
      }
    }

    if (this.autoFollow || this.userTouching) return
    // 上滑（含惯性）：保持用户当前查看的位置，不回弹
    if (this.lastScrollDeltaY < SCROLL_UP_EPSILON) return
    if (gap > SCROLL_RESUME_GAP) return
    this.setAutoFollow(true)
  },

  onThreadScroll(e) {
    const detail = (e && e.detail) || {}
    const top = Number(detail.scrollTop)
    const height = Number(detail.scrollHeight)
    if (!isFinite(top)) return
    // 方向只依据 scrollTop 的变化量：程序化吸底只会让 scrollTop 变大，
    // 因此 scrollTop 变小时一定是用户在向上查看历史（与基础库 deltaY 语义无关）。
    const prevTop = this.lastScrollTop
    this.lastScrollTop = top
    if (isFinite(height)) this.lastScrollHeight = height
    this.lastScrollDeltaY = top - prevTop
    if (!this.threadViewportHeight) this.measureThreadViewport()

    // 主动上滑：不论距离多短都立即退出跟随，并取消待执行的吸底
    if (this.lastScrollDeltaY <= -SCROLL_UP_EPSILON) {
      this.followScrollPending = false
      if (this.autoFollow) this.setAutoFollow(false)
      return
    }
    this.scheduleFollowCheck()
  },

  onThreadTouchStart() {
    this.touchSeq = (this.touchSeq || 0) + 1
    this.userTouching = true
    this.touchTopAtStart = this.lastScrollTop
    this.followScrollPending = false
    this.measureThreadViewport()
  },

  onThreadTouchEnd() {
    const start = this.touchTopAtStart
    const seq = this.touchSeq
    this.touchTopAtStart = null
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    // 抬手时内容被上滑过（哪怕几个像素）：稳定停在当前位置
    if (typeof start === 'number' && this.lastScrollTop < start - SCROLL_UP_EPSILON) {
      this.userTouching = false
      this.followScrollPending = false
      if (this.autoFollow) this.setAutoFollow(false)
      return
    }
    if (!this.autoFollow) {
      this.userTouching = false
      this.scheduleFollowCheck()
      return
    }
    // 先保持触摸锁，等惯性滚动的 scroll 事件到达后再决定是否补一次吸底；
    // 期间若判定为上滑则直接保持当前位置。
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (this.destroyed) return
      if (this.touchSeq !== seq) return
      this.userTouching = false
      if (!this.autoFollow) return
      if (this.lastScrollDeltaY <= -SCROLL_UP_EPSILON) return
      if (typeof start === 'number' && this.lastScrollTop < start - SCROLL_UP_EPSILON) return
      this.scrollToBottom()
    }, SCROLL_TOUCH_SETTLE_MS)
  },

  onThreadReachBottom() {
    this.followScrollPending = false
    // scrolltolower 带 96px 阈值，只有真正贴底且不是上滑时才恢复跟随
    if (this.lastScrollDeltaY <= -SCROLL_UP_EPSILON) return
    const viewport = this.threadViewportHeight
    const height = this.lastScrollHeight
    if (!viewport || !height) return
    const gap = Math.max(0, height - this.lastScrollTop - viewport)
    if (gap > SCROLL_RESUME_GAP) return
    if (!this.autoFollow) this.setAutoFollow(true)
  },

  onJumpToBottom() {
    if (!this.msgs.length) return
    this.scrollToBottom(true)
  },

  addNotice(text, kind) {
    if (!text) return
    this.msgs.push({
      id: uid('n'),
      role: 'notice',
      text: text,
      status: kind === 'error' ? 'error' : 'done',
      timeText: util.formatTime(Date.now())
    })
    this.dirty = {}
    this.setData({ msgs: this.msgs.slice() })
    this.scrollToBottom()
  },

  msgIndex(id) {
    for (let i = 0; i < this.msgs.length; i++) {
      if (this.msgs[i].id === id) return i
    }
    return -1
  },

  // 「思考过程」折叠：展开时才创建过程节点（思考正文 + 工具调用），收起即释放。
  onToggleReasoning(e) {
    const id = e.currentTarget.dataset.id
    const i = this.msgIndex(id)
    if (i < 0) return
    const next = !this.msgs[i].showReasoning
    this.msgs[i].showReasoning = next
    this.setData({ ['msgs[' + i + '].showReasoning']: next })
    if (next) {
      try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* ignore */ }
    }
  },

  // 一轮对话 = 一条用户消息之后的全部 AI 输出。结果优先模式下它们合并成
  // 一处折叠：只有最后一条气泡露出，承载折叠卡与最终输出，其余整条隐藏。
  retagTurns() {
    if (!this.msgs || !this.msgs.length) return
    const flow = !!this.flowMode
    let run = []
    const closeRun = () => {
      if (!run.length) return
      // 承载折叠卡与最终输出的气泡：本轮最后一条有正文的气泡，否则最后一条
      let carrier = run[run.length - 1]
      for (let i = run.length - 1; i >= 0; i--) {
        if (run[i].text) {
          carrier = run[i]
          break
        }
      }
      const ids = run.map((m) => m.id)
      const same = carrier.turnIds && carrier.turnIds.length === ids.length && carrier.turnIds.join('|') === ids.join('|')
      if (!same) {
        // 回合结构变了（新气泡加入/被删除），折叠内容与展开状态一起重置
        run.forEach((m) => {
          m.showReasoning = false
          m.turnBubbles = []
        })
      }
      let hasThink = false
      run.forEach((m) => {
        if (m.reasoning) hasThink = true
        m.turnHidden = flow && m !== carrier
      })
      carrier.turnIds = ids
      carrier.turnCount = ids.length
      carrier.turnHasThink = hasThink
      run = []
    }
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const msg = this.msgs[i]
      if (msg.role === 'assistant') {
        run.unshift(msg)
        continue
      }
      closeRun()
    }
    closeRun()
  },

  // 折叠列表只放每个气泡的标题；正文仍留在消息对象里，展开某个气泡时才取。
  buildTurnBubbles(answer) {
    const ids = (answer && answer.turnIds) || []
    const out = []
    ids.forEach((id, i) => {
      const msg = this.findMsg(id)
      if (!msg) return
      const hasTools = !!(msg.tools && msg.tools.length)
      if (!hasTools && !msg.reasoning && !String(msg.text || '').trim()) return
      out.push({
        key: 'b' + i,
        msgId: id,
        no: i + 1,
        title: bubbleTitleOf(msg),
        meta: hasTools ? msg.tools.length + ' 步' : '',
        final: id === answer.id,
        show: false,
        loaded: false,
        text: '',
        steps: []
      })
    })
    return out
  },

  // 展开一个气泡：首次展开才把它的过程按「思考 + 工具」成对写进视图。
  loadTurnBubble(msg, bubble) {
    if (!bubble || bubble.loaded) return false
    const source = this.findMsg(bubble.msgId)
    bubble.text = bubble.final ? '' : ((source && source.text) || '')
    bubble.steps = stepsOf(source).map((step, si) => ({
      key: 'p' + si,
      think: step.think || '',
      tools: (step.tools || []).map((tool) => ({
        id: tool.id,
        name: tool.name,
        context: tool.context,
        summary: tool.summary,
        durationText: tool.durationText,
        done: tool.done
      }))
    }))
    bubble.loaded = true
    return true
  },

  onToggleTurn(e) {
    const id = e.currentTarget.dataset.id
    const i = this.msgIndex(id)
    if (i < 0) return
    const msg = this.msgs[i]
    const next = !msg.showReasoning
    msg.showReasoning = next
    const patch = { ['msgs[' + i + '].showReasoning']: next }
    if (next) {
      if (!msg.turnBubbles || !msg.turnBubbles.length) msg.turnBubbles = this.buildTurnBubbles(msg)
      patch['msgs[' + i + '].turnBubbles'] = msg.turnBubbles
      try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* ignore */ }
    } else if (msg.turnBubbles && msg.turnBubbles.length) {
      // 收起整轮时把各气泡也收回，下次展开仍从气泡标题开始
      msg.turnBubbles.forEach((bubble) => { bubble.show = false })
      patch['msgs[' + i + '].turnBubbles'] = msg.turnBubbles
    }
    this.setData(patch)
  },

  // 折叠末尾的两个标签按钮：整轮一次性展开 / 收回所有气泡
  onToggleAllBubbles(e) {
    const id = e.currentTarget.dataset.id
    const open = e.currentTarget.dataset.mode === 'open'
    const i = this.msgIndex(id)
    if (i < 0) return
    const msg = this.msgs[i]
    const bubbles = msg.turnBubbles || []
    if (!bubbles.length) return
    const base = 'msgs[' + i + '].turnBubbles'
    const patch = {}
    bubbles.forEach((bubble, bi) => {
      bubble.show = open
      patch[base + '[' + bi + '].show'] = open
      if (open && this.loadTurnBubble(msg, bubble)) {
        const one = base + '[' + bi + ']'
        patch[one + '.loaded'] = true
        patch[one + '.text'] = bubble.text
        patch[one + '.steps'] = bubble.steps
      }
    })
    this.setData(patch)
    try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* ignore */ }
  },

  onToggleBubble(e) {
    const id = e.currentTarget.dataset.id
    const bi = Number(e.currentTarget.dataset.index)
    const i = this.msgIndex(id)
    if (i < 0) return
    const msg = this.msgs[i]
    const bubble = msg.turnBubbles && msg.turnBubbles[bi]
    if (!bubble) return
    bubble.show = !bubble.show
    const patch = { ['msgs[' + i + '].turnBubbles[' + bi + '].show']: bubble.show }
    if (bubble.show && this.loadTurnBubble(msg, bubble)) {
      const base = 'msgs[' + i + '].turnBubbles[' + bi + ']'
      patch[base + '.loaded'] = true
      patch[base + '.text'] = bubble.text
      patch[base + '.steps'] = bubble.steps
    }
    this.setData(patch)
  },

  // ── display mode (交换当前 / 结果优先) ──────────────────────────────

  // 输出过程中不允许切换展示模式：半截气泡在两种渲染结构之间转换会显示错乱。
  outputBusy() {
    if (this.data.streaming || this.data.sending) return true
    const msg = this.currentStream()
    return !!(msg && msg.status === 'streaming')
  },

  onDisplayMode(e) {
    if (this.outputBusy()) {
      wx.showToast({ title: 'AI 输出中，结束后再切换', icon: 'none' })
      return
    }
    const mode = e.currentTarget.dataset.mode === 'classic' ? 'classic' : 'flow'
    if (mode === this.displayMode) return
    this.displayMode = mode
    this.flowMode = mode === 'flow'
    if (this.endpoint) store.setSettings(this.endpoint.id, { displayMode: mode })
    this.applyDisplayMode()
    try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* ignore */ }
    wx.showToast({ title: mode === 'flow' ? '已切换到结果优先' : '已切换到完整过程', icon: 'none' })
  },

  // 切换后历史消息与进行中的回合共用同一套折叠默认值，避免表现不一致。
  applyDisplayMode() {
    ;(this.msgs || []).forEach((msg) => {
      if (msg.role !== 'assistant') return
      msg.showReasoning = false
      msg.turnBubbles = []
    })
    this.retagTurns()
    this.dirty = {}
    this.liveSig = ''
    this.setData({
      displayMode: this.displayMode,
      flowMode: this.flowMode,
      liveStatus: null,
      msgs: this.msgs.slice()
    })
    this.syncLive()
    this.measureThreadViewport()
  },

  // ── header actions ────────────────────────────────────────────────

  onMenu() {
    if (!this.endpoint) {
      wx.reLaunch({ url: '/pages/endpoints/index' })
      return
    }
    this.flushDraft()
    this.saveLast()
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    let url = '/pages/sessions/index?id=' + this.endpoint.id
    if (this.profile) url += '&profile=' + encodeURIComponent(this.profile)
    wx.reLaunch({ url: url })
  },

  onFiles() {
    if (!this.endpoint) return
    if (this.cwd) {
      this.setData({ fsRoot: this.cwd, fsFocus: '', fsShow: true })
      return
    }
    wx.showLoading({ title: '定位工作区', mask: true })
    files.defaultCwd(this.endpoint, this.profile)
      .then((body) => {
        wx.hideLoading()
        if (this.destroyed) return
        if (body && body.cwd) {
          this.cwd = body.cwd
          this.applyMeta()
        }
        this.setData({ fsRoot: this.cwd || '', fsFocus: '', fsShow: true })
      })
      .catch((err) => {
        wx.hideLoading()
        if (this.destroyed) return
        if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          this.onAuthExpired()
          return
        }
        wx.showToast({ title: util.errorText(err), icon: 'none' })
      })
  },

  onFsClose() {
    this.setData({ fsShow: false, fsFocus: '' })
  },

  // ── details --------------------------------------------------------

  buildDetails() {
    const row = this.metaRow || {}
    const source = row.source || 'local'
    const channel = workspaces.channelOf(source)
    return {
      id: this.storedId || '（新会话）',
      ws: this.cwd || '服务器默认目录',
      model: this.modelCurrent || row.model || this.data.modelLabel || '默认模型',
      source: workspaces.sourceText(source),
      channel: workspaces.channelInfo(channel).label,
      status: this.data.streaming ? '回复中' : '空闲',
      created: util.formatDateTime(row.started_at) || '—',
      updated: util.formatDateTime(row.last_active) || '—',
      messages: row.message_count != null ? row.message_count : this.msgs.length,
      tokens: this.data.usageText || '—',
      profile: this.profile || 'default',
      canRename: !!this.runtimeId
    }
  },

  onDetails() {
    this.setData({
      detailsOpen: true,
      detailsTitle: this.title || '',
      details: this.buildDetails()
    })
  },

  onDetailsClose() {
    this.setData({ detailsOpen: false })
  },

  onDetailsTitle(e) {
    this.setData({ detailsTitle: e.detail.value })
  },

  onDetailsSave() {
    if (this.data.detailsSaving) return
    const title = (this.data.detailsTitle || '').trim()
    if (!title) {
      wx.showToast({ title: '标题不能为空', icon: 'none' })
      return
    }
    if (!this.gw || !this.runtimeId) {
      wx.showToast({ title: '会话建立后才能重命名', icon: 'none' })
      return
    }
    if (title === this.title) {
      this.onDetailsClose()
      return
    }
    this.setData({ detailsSaving: true })
    this.gw.rpc('session.title', { session_id: this.runtimeId, title: title }, 15000)
      .then((r) => {
        this.setTitle((r && r.title) || title)
        this.setData({
          detailsSaving: false,
          'details.canRename': true
        })
        wx.showToast({ title: '已重命名', icon: 'none' })
      })
      .catch((err) => {
        this.setData({ detailsSaving: false })
        wx.showToast({ title: util.errorText(err), icon: 'none' })
      })
  },

  onDetailsTheme() {
    this.setData({ detailsOpen: false, showTheme: true })
  },

  // ── model picker ---------------------------------------------------

  onModelFromDetails() {
    this.setData({ detailsOpen: false })
    this.onModelOpen()
  },

  onModelOpen() {
    if (!this.endpoint) return
    try { wx.hideKeyboard() } catch (e) { /* ignore */ }
    this.setData({ modelOpen: true, modelSearch: '', inputFocus: false })
    this.loadReasoning()
    if (this.modelOptions) {
      this.applyModelOptions(this.modelOptions)
      return
    }
    this.loadModelOptions(false)
  },

  onModelClose() {
    this.setData({ modelOpen: false })
  },

  onModelRefresh() {
    this.loadModelOptions(true)
  },

  loadModelOptions(refresh) {
    if (!this.endpoint || this.data.modelLoading) return
    this.setData({ modelLoading: true, modelError: '' })
    const done = (body) => {
      if (this.destroyed) return
      this.modelOptions = body || {}
      this.setData({ modelLoading: false })
      this.applyModelOptions(this.modelOptions)
    }
    const fail = (err) => {
      if (this.destroyed) return
      if (err && (err.rpcCode === 4401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED' || err.statusCode === 401)) {
        this.setData({ modelLoading: false })
        this.onAuthExpired()
        return
      }
      if (this.data.modelProviders.length) {
        this.setData({ modelLoading: false })
        wx.showToast({ title: util.errorText(err), icon: 'none' })
        return
      }
      this.setData({ modelLoading: false, modelError: util.errorText(err) })
    }
    if (this.gw && this.gw.isOpen()) {
      const params = {}
      if (this.runtimeId) params.session_id = this.runtimeId
      if (this.profile) params.profile = this.profile
      if (refresh) params.refresh = true
      this.gw.rpc('model.options', params, 60000).then(done).catch(fail)
      return
    }
    const query = []
    if (this.profile) query.push('profile=' + encodeURIComponent(this.profile))
    if (refresh) query.push('refresh=1')
    http.authed(this.endpoint, {
      path: '/api/model/options' + (query.length ? '?' + query.join('&') : ''),
      timeout: 45000
    }).then((res) => {
      if (this.destroyed) return
      if (res.statusCode === 401) {
        this.setData({ modelLoading: false })
        this.onAuthExpired()
        return
      }
      if (res.statusCode !== 200) {
        throw util.makeError('HTTP', '加载模型失败（HTTP ' + res.statusCode + '）')
      }
      done(res.data || {})
    }).catch(fail)
  },

  applyModelOptions(body) {
    const providers = models.providers(body)
    const current = providers.filter((p) => p.current)[0] ||
      providers.filter((p) => p.slug === body.provider)[0] || null
    let selected = this.data.modelProvider
    if (!providers.some((p) => p.slug === selected)) {
      selected = this.pendingProvider && providers.some((p) => p.slug === this.pendingProvider)
        ? this.pendingProvider
        : (current ? current.slug : (providers[0] ? providers[0].slug : ''))
    }
    const patch = {
      modelProviders: providers,
      modelProvider: selected,
      modelLoading: false,
      modelError: ''
    }
    if (body.model && !this.modelCurrent) {
      this.modelCurrent = body.model
      patch.modelLabel = body.model
      patch.modelShort = shortModel(body.model)
    }
    const activeProvider = providers.filter((p) => p.slug === this.pendingProvider)[0] || current
    const activeModel = this.modelCurrent || body.model || ''
    patch.reasoningAvailable = !activeProvider || models.reasoningSupported(activeProvider, activeModel)
    this.setData(patch, () => this.buildModelList())
  },

  onModelProvider(e) {
    const slug = e.currentTarget.dataset.slug
    if (!slug || slug === this.data.modelProvider) return
    this.setData({ modelProvider: slug, modelSearch: '' }, () => this.buildModelList())
  },

  onModelSearch(e) {
    this.setData({ modelSearch: e.detail.value || '' }, () => this.buildModelList())
  },

  onModelSearchClear() {
    this.setData({ modelSearch: '' }, () => this.buildModelList())
  },

  buildModelList() {
    const query = String(this.data.modelSearch || '').trim().toLowerCase()
    const providers = this.data.modelProviders || []
    const currentModel = String(this.modelCurrent || '').toLowerCase()
    const activeProvider = providers.filter((p) => p.slug === this.pendingProvider)[0] ||
      providers.filter((p) => p.current)[0] || null
    const activeSlug = activeProvider ? activeProvider.slug : ''
    const rows = []
    const add = (provider, model) => {
      if (query && model.toLowerCase().indexOf(query) < 0) return
      const label = shortModel(model)
      const cap = models.capability(provider, model)
      rows.push({
        key: provider.slug + '::' + model,
        model: model,
        label: label,
        sub: query ? provider.name : (model === label ? '' : model),
        slug: provider.slug,
        reasoning: !!(cap && cap.reasoning),
        fast: !!(cap && cap.fast),
        current: provider.slug === activeSlug && currentModel === model.toLowerCase()
      })
    }
    if (query) {
      providers.forEach((provider) => provider.models.forEach((model) => add(provider, model)))
    } else {
      const provider = providers.filter((p) => p.slug === this.data.modelProvider)[0]
      if (provider) provider.models.forEach((model) => add(provider, model))
    }
    this.setData({ modelList: rows.slice(0, 200), modelListMore: rows.length > 200 })
  },

  onModelPick(e) {
    if (this.data.modelSwitching) return
    if (e.currentTarget.dataset.current) {
      this.onModelClose()
      return
    }
    const model = String(e.currentTarget.dataset.model || '')
    const slug = String(e.currentTarget.dataset.slug || '')
    if (!model || !slug) return
    this.switchModel(model, slug, false)
  },

  switchModel(model, slug, confirmed) {
    if (!this.runtimeId && !this.storedId) {
      this.pendingModel = model
      this.pendingProvider = slug
      this.selectPendingModel(model, slug)
      wx.showToast({ title: '新会话将使用该模型', icon: 'none' })
      return
    }
    if (!this.gw) {
      wx.showToast({ title: '连接未就绪，请稍后重试', icon: 'none' })
      return
    }
    this.setData({ modelSwitching: true })
    this.ensureLiveSession()
      .then((sid) => {
        const params = {
          session_id: sid,
          key: 'model',
          value: model + ' --provider ' + slug
        }
        if (this.profile) params.profile = this.profile
        if (confirmed) params.confirm_expensive_model = true
        return this.gw.rpc('config.set', params, 90000)
      })
      .then((res) => {
        if (this.destroyed) return
        this.setData({ modelSwitching: false })
        if (res && res.confirm_required) {
          this.confirmModelSwitch(res, model, slug)
          return
        }
        this.finishModelSwitch(res || {}, model, slug)
      })
      .catch((err) => {
        if (this.destroyed) return
        this.setData({ modelSwitching: false })
        wx.showToast({ title: util.errorText(err), icon: 'none' })
      })
  },

  confirmModelSwitch(res, model, slug) {
    wx.showModal({
      title: '确认切换模型',
      content: res.confirm_message || '该模型可能产生较高费用，确认切换？',
      confirmText: '确认切换',
      success: (r) => {
        if (r.confirm) this.switchModel(model, slug, true)
      }
    })
  },

  selectPendingModel(model, slug) {
    const providers = (this.data.modelProviders || []).map((p) =>
      Object.assign({}, p, { current: p.slug === slug }))
    providers.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
    this.modelCurrent = model
    const provider = providers.filter((p) => p.slug === slug)[0] || null
    const available = !provider || models.reasoningSupported(provider, model)
    if (this.modelOptions) {
      this.modelOptions.model = model
      this.modelOptions.provider = slug
      this.modelOptions.providers = (this.modelOptions.providers || []).map((p) =>
        Object.assign({}, p, { is_current: p.slug === slug }))
    }
    const patch = {
      modelOpen: false,
      modelProviders: providers,
      modelProvider: slug,
      modelLabel: model,
      modelShort: shortModel(model),
      'details.model': model,
      modelSwitching: false,
      reasoningAvailable: available
    }
    if (!available && this.pendingReasoning) {
      this.pendingReasoning = ''
      this.reasoningLevel = ''
      patch.reasoningLevel = ''
      patch.reasoningLabel = '默认'
    }
    this.setData(patch, () => this.buildModelList())
  },

  finishModelSwitch(res, model, slug) {
    const providers = (this.data.modelProviders || []).map((p) =>
      Object.assign({}, p, { current: p.slug === slug }))
    providers.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
    this.modelCurrent = model
    if (this.metaRow) this.metaRow.model = model
    if (this.modelOptions) {
      this.modelOptions.model = model
      this.modelOptions.provider = slug
      this.modelOptions.providers = (this.modelOptions.providers || []).map((p) =>
        Object.assign({}, p, { is_current: p.slug === slug }))
    }
    const provider = providers.filter((p) => p.slug === slug)[0] || null
    this.setData({
      modelOpen: false,
      modelProviders: providers,
      modelProvider: slug,
      modelLabel: model,
      modelShort: shortModel(model),
      'details.model': model,
      modelSwitching: false,
      reasoningAvailable: !provider || models.reasoningSupported(provider, model)
    }, () => this.buildModelList())
    const deferred = !!res.deferred
    const warning = res.warning || ''
    if (warning) {
      wx.showModal({
        title: deferred ? '已排队切换' : '已切换模型',
        content: warning + (deferred ? '\n将在下一轮对话生效。' : ''),
        showCancel: false
      })
      return
    }
    wx.showToast({ title: deferred ? '将在下一轮生效' : '已切换模型', icon: 'none' })
  },

  // ── reasoning effort ----------------------------------------------

  setReasoning(level, touched) {
    const id = String(level || '').toLowerCase()
    this.reasoningLevel = id
    if (touched) this.reasoningTouched = true
    this.setData({
      reasoningLevel: id,
      reasoningLabel: models.levelLabel(id) || (id ? id : '默认')
    })
  },

  loadReasoning() {
    if (!this.gw || !this.gw.isOpen() || this.reasoningTouched || this.pendingReasoning) return
    const params = { key: 'reasoning' }
    if (this.runtimeId) params.session_id = this.runtimeId
    if (this.profile) params.profile = this.profile
    this.gw.rpc('config.get', params, 15000)
      .then((res) => {
        if (this.destroyed || this.reasoningTouched || this.pendingReasoning) return
        const level = res && typeof res.value === 'string' ? res.value : ''
        if (level) this.setReasoning(level, false)
      })
      .catch(() => { /* effort stays at its default label */ })
  },

  onReasoningPick(e) {
    const level = String(e.currentTarget.dataset.id || '').toLowerCase()
    if (!level || this.data.reasoningBusy) return
    if (!this.data.reasoningAvailable) {
      wx.showToast({ title: '当前模型不支持推理强度', icon: 'none' })
      return
    }
    const label = models.levelLabel(level) || level
    if (!this.runtimeId && !this.storedId) {
      this.pendingReasoning = level
      this.setReasoning(level, true)
      wx.showToast({ title: '新会话推理：' + label, icon: 'none' })
      return
    }
    if (!this.gw) {
      wx.showToast({ title: '连接未就绪，请稍后重试', icon: 'none' })
      return
    }
    this.setData({ reasoningBusy: true })
    this.ensureLiveSession()
      .then((sid) => {
        const params = { session_id: sid, key: 'reasoning', value: level, scope: 'session' }
        if (this.profile) params.profile = this.profile
        return this.gw.rpc('config.set', params, 60000)
      })
      .then((res) => {
        if (this.destroyed) return
        const applied = res && typeof res.value === 'string' ? res.value : level
        this.setData({ reasoningBusy: false })
        this.setReasoning(applied, true)
        wx.showToast({ title: '推理强度：' + (models.levelLabel(applied) || applied), icon: 'none' })
      })
      .catch((err) => {
        if (this.destroyed) return
        this.setData({ reasoningBusy: false })
        wx.showToast({ title: util.errorText(err), icon: 'none' })
      })
  },

  // ── theme sheet ----------------------------------------------------

  onThemeClose() {
    this.setData({ showTheme: false })
  },

  onThemePick(e) {
    const id = e.currentTarget.dataset.id
    const picked = theme.pick(id, this)
    this.rebuildRich()
    this.lastThemeId = picked.id
    wx.showToast({ title: '已切换「' + picked.name + '」', icon: 'none' })
  },

  // ── copy / media ---------------------------------------------------

  onCopyMsg(e) {
    const id = e.currentTarget.dataset.id
    const msg = this.findMsg(id)
    if (!msg || !msg.text) {
      wx.showToast({ title: '没有可复制的内容', icon: 'none' })
      return
    }
    wx.setClipboardData({ data: msg.text })
    try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* ignore */ }
  },

  onPreviewUser(e) {
    const id = e.currentTarget.dataset.id
    const index = Number(e.currentTarget.dataset.index)
    const msg = this.findMsg(id)
    if (!msg || !msg.images || !msg.images[index]) return
    wx.previewImage({ urls: msg.images, current: msg.images[index] })
  },

  onPreviewMd(e) {
    const id = e.currentTarget.dataset.id
    const index = Number(e.currentTarget.dataset.index)
    const msg = this.findMsg(id)
    const img = msg && msg.mdImages ? msg.mdImages[index] : null
    if (!img || (!img.displaySrc && !img.raw)) return
    if (!img.displaySrc) {
      // A failed tile is a stale backend/gateway error more often than a bad path: offer a retry.
      const pending = this.resolveImages(msg, true)
      if (!pending) return
      wx.showLoading({ title: '重新加载', mask: true })
      pending.then(() => {
        wx.hideLoading()
        if (!img.displaySrc) wx.showToast({ title: img.error || '图片载入失败', icon: 'none' })
      })
      return
    }
    files.previewImageSrc(this.endpoint, img.displaySrc || img.raw, this.profile, this.cwd)
      .catch((err) => wx.showToast({ title: util.errorText(err), icon: 'none' }))
  },

  fileCardAt(e) {
    const id = e.currentTarget.dataset.id
    const index = Number(e.currentTarget.dataset.index)
    const msg = this.findMsg(id)
    return (msg && msg.fileCards && msg.fileCards[index]) || null
  },

  onFileCard(e) {
    const card = this.fileCardAt(e)
    if (!card) return
    if (card.external) {
      wx.setClipboardData({ data: card.path })
      return
    }
    this.previewFile(card.abs || card.path, card.name)
  },

  onFileCardFolder(e) {
    const card = this.fileCardAt(e)
    if (!card || card.external) return
    this.setData({
      fsRoot: card.dir || this.cwd || '',
      fsFocus: card.abs || card.path,
      fsShow: true
    })
  },

  previewFile(path, name) {
    if (markdown.isImageName(name)) {
      wx.showLoading({ title: '加载图片', mask: true })
      files.previewPath(this.endpoint, path, this.profile)
        .then(() => wx.hideLoading())
        .catch((err) => {
          wx.hideLoading()
          wx.showToast({ title: util.errorText(err), icon: 'none' })
        })
      return
    }
    if (markdown.isTextName(name)) {
      const dir = files.parentPath(path)
      this.setData({ fsRoot: dir || this.cwd || '', fsFocus: path, fsShow: true }, () => {
        const sheet = this.selectComponent('#filesheet')
        if (sheet) sheet.openPreview(path, name)
      })
      return
    }
    this.downloadFile(path, name)
  },

  downloadFile(path, name) {
    wx.showLoading({ title: '下载中', mask: true })
    files.open(this.endpoint, path, this.profile, name)
      .then(() => wx.hideLoading())
      .catch((err) => {
        wx.hideLoading()
        wx.showToast({
          title: err && err.code === 'OPEN' ? '文件已下载，当前类型无法直接打开' : util.errorText(err),
          icon: 'none'
        })
      })
  },

  // ── server requests ────────────────────────────────────────────────

  onRequestCancel(payload) {
    if (this.destroyed || !payload) return
    const id = payload.id || payload.request_id
    if (!id) return
    const approval = this.data.approval
    if (approval && (approval.id === id || approval.requestId === id)) {
      this.approvalActive = false
      this.setData({ approval: null })
    }
    const clarify = this.data.clarify
    if (clarify && (clarify.frameId === id || clarify.requestId === id)) {
      this.clarifyActive = false
      this.setData({ clarify: null })
    }
    const secret = this.data.secretPrompt
    if (secret && (secret.frameId === id || secret.requestId === id)) {
      this.secretActive = false
      this.setData({ secretPrompt: null })
    }
  },

  onServerRequest(frameId, method, params) {
    if (this.destroyed) return
    if (method === 'approval') {
      this.showApproval(params, frameId)
    } else if (method === 'clarify') {
      this.showClarify(params, frameId)
    } else if (method === 'sudo' || method === 'secret' || method === 'vault.unlock_prompt') {
      this.showSecret(method, params, frameId)
    } else if (this.gw) {
      this.gw.respondError(frameId, -32601, 'mini program does not handle ' + method)
    }
  },

  showApproval(params, frameId) {
    const choices = Array.isArray(params.choices) && params.choices.length ? params.choices : ['once', 'deny']
    this.approvalActive = true
    this.setData({
      approval: {
        id: frameId || '',
        requestId: params.request_id || '',
        command: params.command || '',
        description: params.description || '',
        toolName: params.tool_name || '',
        fallback: !frameId,
        choices: choices.map((choice) => ({
          value: choice,
          label: CHOICE_TEXT[choice] || choice,
          primary: choice !== 'deny'
        }))
      }
    })
    try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* ignore */ }
  },

  onApproval(e) {
    const choice = e.currentTarget.dataset.choice
    const approval = this.data.approval
    if (!choice || !approval || !this.gw) return
    if (approval.fallback) {
      this.gw.rpc('approval.respond', {
        session_id: this.runtimeId,
        request_id: approval.requestId,
        choice: choice
      }, 15000).then(() => {
        if (!this.destroyed) this.closeApproval(choice)
      }).catch((err) => {
        if (!this.destroyed) this.addNotice('审批提交失败：' + util.errorText(err), 'error')
      })
      return
    }
    // Keep the card visible when the socket has gone away so the user can
    // retry instead of silently losing the approval.
    const sent = this.gw.respond(approval.id, { choice: choice })
    if (!sent) {
      wx.showToast({ title: '连接已断开，请重试', icon: 'none' })
      return
    }
    this.closeApproval(choice)
  },

  closeApproval(choice) {
    this.approvalActive = false
    this.setData({ approval: null })
    this.addNotice('已选择：' + (CHOICE_TEXT[choice] || choice))
  },

  showClarify(params, frameId) {
    const questions = (params.questions || []).map((q) => ({
      qid: q.qid,
      question: q.question || '',
      multi: !!q.multi_select,
      value: '',
      choices: (Array.isArray(q.choices) ? q.choices : []).map((choice) => ({
        value: choice,
        label: choice,
        on: false
      }))
    }))
    this.clarifyActive = true
    this.setData({ clarify: { frameId: frameId, questions: questions } })
  },

  onClarifyChoice(e) {
    const qi = Number(e.currentTarget.dataset.qindex)
    const value = e.currentTarget.dataset.choice
    const clarify = this.data.clarify
    if (!clarify || !clarify.questions[qi]) return
    const question = clarify.questions[qi]
    const choices = question.choices.map((choice) => {
      if (question.multi) {
        return Object.assign({}, choice, {
          on: choice.value === value ? !choice.on : choice.on
        })
      }
      return Object.assign({}, choice, { on: choice.value === value })
    })
    this.setData({ ['clarify.questions[' + qi + '].choices']: choices })
  },

  onClarifyInput(e) {
    const qi = Number(e.currentTarget.dataset.qindex)
    const clarify = this.data.clarify
    if (!clarify || !clarify.questions[qi]) return
    this.setData({ ['clarify.questions[' + qi + '].value']: e.detail.value })
  },

  onClarifySubmit() {
    const clarify = this.data.clarify
    if (!clarify || !this.gw) return
    const answers = {}
    clarify.questions.forEach((q) => {
      if (!q.choices.length) {
        answers[q.qid] = (q.value || '').trim()
        return
      }
      const chosen = q.choices.filter((c) => c.on).map((c) => c.value)
      answers[q.qid] = q.multi ? chosen : (chosen[0] || '')
    })
    const sent = this.gw.respond(clarify.frameId, { answers: answers })
    if (!sent) {
      wx.showToast({ title: '连接已断开，请重试', icon: 'none' })
      return
    }
    this.clarifyActive = false
    this.setData({ clarify: null })
  },

  onClarifySkip() {
    const clarify = this.data.clarify
    if (!clarify || !this.gw) return
    const sent = this.gw.respond(clarify.frameId, { answers: {} })
    if (!sent) {
      wx.showToast({ title: '连接已断开，请重试', icon: 'none' })
      return
    }
    this.clarifyActive = false
    this.setData({ clarify: null })
  },

  showSecret(method, params, frameId) {
    const label = params.env_var ? '保存到 ' + params.env_var : (params.display_name || '')
    this.secretActive = true
    this.setData({
      secretPrompt: {
        frameId: frameId,
        method: method,
        prompt: params.prompt || params.command || '请输入凭据',
        label: label,
        value: ''
      }
    })
  },

  onSecretInput(e) {
    this.setData({ 'secretPrompt.value': e.detail.value })
  },

  onSecretSubmit() {
    const prompt = this.data.secretPrompt
    if (!prompt || !this.gw) return
    const sent = this.gw.respond(prompt.frameId, { value: prompt.value || '' })
    if (!sent) {
      wx.showToast({ title: '连接已断开，请重试', icon: 'none' })
      return
    }
    this.secretActive = false
    this.setData({ secretPrompt: null })
  },

  onSecretCancel() {
    const prompt = this.data.secretPrompt
    if (!prompt || !this.gw) return
    const sent = this.gw.respond(prompt.frameId, { value: '' })
    if (!sent) {
      wx.showToast({ title: '连接已断开，请重试', icon: 'none' })
      return
    }
    this.secretActive = false
    this.setData({ secretPrompt: null })
  },

  // ── drafts ─────────────────────────────────────────────────────────

  draftKey() {
    return drafts.key(this.endpoint.id, this.storedId, this.cwd)
  },

  restoreDraftSoon() {
    if (this.data.input) return
    const text = drafts.get(this.draftKey())
    if (!text) return
    this.setData({ input: text, inputHeight: inputHeightFor(text, false), draftReady: true })
    this.recordInput(text, 'draft')
  },

  saveDraftSoon() {
    // 改写、语音、建议、撤销改写等程序性改动都会在这里保存草稿，
    // 顺带补记一步输入历史；打字已由 onInput 记录，值相同会直接跳过。
    this.recordInput(this.data.input, 'edit')
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null
      this.flushDraft()
    }, 350)
  },

  flushDraft() {
    if (!this.endpoint) return
    if (this.draftTimer) {
      clearTimeout(this.draftTimer)
      this.draftTimer = null
    }
    drafts.set(this.draftKey(), this.data.input)
  },

  // Leaving mid-stream must not silently drop messages queued for the next turn.
  flushQueuedIntoDraft() {
    if (!this.outbox || !this.outbox.length) return
    // The item currently being submitted may already be on the server; putting
    // it back into the draft would send it twice.
    const pending = this.outbox
      .filter((item) => !this.drainingId || item.id !== this.drainingId)
      .map((item) => {
        const text = String(item.text || '').trim()
        if (text) return text
        return (item.images && item.images.length) ? '[图片]' : '[文件]'
      }).filter(Boolean).join('\n\n')
    if (!pending) return
    const current = this.data.input || ''
    const next = current.trim() ? current + '\n\n' + pending : pending
    this.data.input = next
    this.data.draftReady = true
    this.outbox = []
    this.recordInput(next, 'queue')
  },

  // ── composer ───────────────────────────────────────────────────────

  // ── 输入历史（撤销 / 恢复） ────────────────────────────────────────

  resetInputHistory(text) {
    this.inputHistory = [String(text || '')]
    this.inputHistoryIndex = 0
    this.inputHistoryAt = 0
    this.inputHistoryKind = 'reset'
    this.syncInputHistoryFlags()
  },

  syncInputHistoryFlags() {
    const history = this.inputHistory
    const canUndo = !!history && this.inputHistoryIndex > 0
    const canRedo = !!history && this.inputHistoryIndex < history.length - 1
    if (canUndo !== this.data.inputCanUndo || canRedo !== this.data.inputCanRedo) {
      this.setData({ inputCanUndo: canUndo, inputCanRedo: canRedo })
    }
  },

  // 连续打字合并为一步；改写、语音、草稿恢复等程序性改动各自独立成步，
  // 一次撤销不会同时吞掉几类不同的编辑。
  recordInput(text, kind) {
    const value = String(text || '')
    if (!this.inputHistory) {
      this.resetInputHistory(value)
      return
    }
    if (value === this.inputHistory[this.inputHistoryIndex]) return
    const now = Date.now()
    const merge = kind === 'typing' &&
      this.inputHistoryKind === 'typing' &&
      this.inputHistoryIndex === this.inputHistory.length - 1 &&
      now - this.inputHistoryAt < INPUT_HISTORY_GROUP_MS
    // 在旧状态上产生新输入时，丢弃原有的恢复分支
    if (this.inputHistoryIndex < this.inputHistory.length - 1) {
      this.inputHistory = this.inputHistory.slice(0, this.inputHistoryIndex + 1)
    }
    if (merge) {
      this.inputHistory[this.inputHistoryIndex] = value
    } else {
      this.inputHistory.push(value)
      if (this.inputHistory.length > INPUT_HISTORY_LIMIT) this.inputHistory.shift()
      this.inputHistoryIndex = this.inputHistory.length - 1
    }
    this.inputHistoryAt = now
    this.inputHistoryKind = kind
    this.syncInputHistoryFlags()
  },

  applyInputHistory() {
    const text = this.inputHistory[this.inputHistoryIndex]
    this.inputHistoryAt = 0
    this.inputHistoryKind = 'move'
    this.setData({
      input: text,
      draftReady: hasDraft(text, this.data.pendingImages, this.data.pendingFiles),
      inputHeight: inputHeightFor(text, this.data.inputFocus),
      enhanceUndo: ''
    })
    this.saveDraftSoon()
    this.syncInputHistoryFlags()
  },

  onInputUndo() {
    if (!this.inputHistory || this.inputHistoryIndex <= 0) return
    this.inputHistoryIndex -= 1
    this.applyInputHistory()
    try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* ignore */ }
  },

  onInputRedo() {
    if (!this.inputHistory || this.inputHistoryIndex >= this.inputHistory.length - 1) return
    this.inputHistoryIndex += 1
    this.applyInputHistory()
    try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* ignore */ }
  },

  onInput(e) {
    const value = e.detail.value
    const patch = {
      input: value,
      draftReady: hasDraft(value, this.data.pendingImages, this.data.pendingFiles),
      inputHeight: inputHeightFor(value, this.data.inputFocus)
    }
    // 用户手动改过内容后，「撤销改写」已没有意义
    if (this.data.enhanceUndo) patch.enhanceUndo = ''
    this.setData(patch)
    this.recordInput(value, 'typing')
    this.saveDraftSoon()
  },

  onLineChange(e) {
    const count = (e.detail && e.detail.lineCount) || 0
    this.setData({
      inputHeight: inputHeightFor(this.data.input, this.data.inputFocus, count)
    })
  },

  onFocus() {
    this.setData({
      inputFocus: true,
      inputHeight: inputHeightFor(this.data.input, true)
    }, () => {
      this.measureThreadViewport()
      this.scrollToBottom()
    })
  },

  onBlur() {
    const patch = {
      inputFocus: false,
      inputHeight: inputHeightFor(this.data.input, false)
    }
    // 切换全屏时焦点会在两个 textarea 之间交接，键盘并没有真正收起，
    // 这时清掉高度会让全屏面板被键盘挡住。
    if (!this.fsSwitching) patch.keyboardHeight = 0
    this.setData(patch, () => this.measureThreadViewport())
    this.flushDraft()
  },

  onKeyboardHeight(e) {
    const raw = e && e.detail ? Number(e.detail.height) || 0 : 0
    let shrink = 0
    try {
      const win = wx.getWindowInfo()
      if (this.baseWindowHeight && win && win.windowHeight) {
        shrink = Math.max(0, this.baseWindowHeight - win.windowHeight)
      }
    } catch (err) { /* ignore */ }
    const height = Math.max(0, raw - shrink)
    if (height === this.data.keyboardHeight) return
    const patch = { keyboardHeight: height }
    if (this.data.fullscreen) patch.fsInputHeight = this.fullscreenInputHeight(height)
    this.setData(patch, () => {
      this.measureThreadViewport()
      if (height) this.scrollToBottom()
    })
  },

  // ── 输入框全屏 ──────────────────────────────────────────────────────

  // 全屏面板顶部要避开状态栏和右上角胶囊，否则标题与「还原」会被压住。
  computeFullscreenTop() {
    let status = 0
    let capsuleBottom = 0
    try {
      const win = wx.getWindowInfo()
      status = Number(win.statusBarHeight) || 0
    } catch (e) { /* ignore */ }
    try {
      if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
        const rect = wx.getMenuButtonBoundingClientRect()
        if (rect && rect.height) capsuleBottom = Number(rect.bottom) || 0
      }
    } catch (e) { /* ignore */ }
    // 少数环境拿不到胶囊信息，用状态栏 + 44px 兜底（胶囊的常见高度）。
    if (!capsuleBottom) capsuleBottom = status + 44
    return Math.round(Math.max(status + 8, capsuleBottom + 8))
  },

  fullscreenInputHeight(keyboardHeight, topPad) {
    const kb = keyboardHeight === undefined ? (this.data.keyboardHeight || 0) : keyboardHeight
    const pad = topPad === undefined ? (this.data.fsTopPad || 0) : topPad
    const winH = this.baseWindowHeight || (() => {
      try { return wx.getWindowInfo().windowHeight || 560 } catch (e) { return 560 }
    })()
    return Math.max(80, Math.floor((winH || 560) - kb - pad - FS_BODY_CHROME_PX))
  },

  onFullscreenOpen() {
    if (this.data.fullscreen) return
    const topPad = this.computeFullscreenTop()
    // 内联输入框失焦与全屏输入框聚焦几乎同时发生，用一个短窗口把它们
    // 视为同一次焦点交接，避免键盘高度被误清零。
    this.fsSwitching = true
    if (this.fsSwitchTimer) clearTimeout(this.fsSwitchTimer)
    this.fsSwitchTimer = setTimeout(() => {
      this.fsSwitchTimer = null
      this.fsSwitching = false
      if (this.destroyed) return
      // 全屏输入框没拿到焦点说明键盘其实已经收起，残留高度会撑出空白。
      if (!this.data.inputFocus && this.data.keyboardHeight) {
        this.setData({ keyboardHeight: 0, fsInputHeight: this.fullscreenInputHeight(0) })
      }
    }, 600)
    this.setData({
      fullscreen: true,
      fsTopPad: topPad,
      fsInputHeight: this.fullscreenInputHeight(undefined, topPad),
      inputFocus: false
    }, () => {
      // 让全屏输入框接管焦点，键盘不会因为切换而收起
      this.setData({ fullscreenFocus: true })
      this.measureThreadViewport()
    })
    try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* ignore */ }
  },

  onFullscreenClose() {
    if (!this.data.fullscreen) return
    if (this.fsSwitchTimer) {
      clearTimeout(this.fsSwitchTimer)
      this.fsSwitchTimer = null
    }
    this.fsSwitching = false
    this.setData({
      fullscreen: false,
      fullscreenFocus: false,
      inputFocus: false,
      keyboardHeight: 0,
      inputHeight: inputHeightFor(this.data.input, false)
    }, () => this.measureThreadViewport())
    try { wx.hideKeyboard() } catch (e) { /* ignore */ }
    this.flushDraft()
  },

  onSuggest(e) {
    const text = e.currentTarget.dataset.text || ''
    this.setData({
      input: text,
      inputFocus: true,
      draftReady: true,
      enhanceUndo: '',
      inputHeight: inputHeightFor(text, true)
    })
    this.saveDraftSoon()
  },

  onCopyText(e) {
    const text = String(e.currentTarget.dataset.text || '')
    if (text) wx.setClipboardData({ data: text })
  },

  onAttach() {
    if (this.data.sending) return
    wx.showActionSheet({
      itemList: ['图片', '文件'],
      success: (res) => {
        if (res.tapIndex === 0) this.onPickImage()
        else if (res.tapIndex === 1) this.onPickFile()
      }
    })
  },

  // ── 增强提示词 ──────────────────────────────────────────────────────

  onEnhanceTap() {
    // 长按会先触发 longpress，再补一个 tap；用锁把补发的点击吞掉
    if (this.enhanceLock) {
      this.enhanceLock = false
      return
    }
    this.runEnhance()
  },

  onEnhanceLongPress() {
    this.enhanceLock = true
    if (this.enhanceLockTimer) clearTimeout(this.enhanceLockTimer)
    this.enhanceLockTimer = setTimeout(() => {
      this.enhanceLock = false
      this.enhanceLockTimer = null
    }, 800)
    this.openEnhanceSheet()
  },

  openEnhanceSheet() {
    if (!this.endpoint) return
    const cfg = enhance.getConfig()
    try { wx.hideKeyboard() } catch (e) { /* ignore */ }
    this.setData({
      enhanceOpen: true,
      inputFocus: false,
      enhanceBaseUrl: cfg.baseUrl,
      enhanceKey: cfg.apiKey,
      enhanceModel: cfg.model,
      enhanceReasoning: cfg.reasoning,
      enhancePrompt: cfg.systemPrompt,
      enhanceReady: enhance.isReady(cfg),
      enhanceTesting: false,
      enhanceTestMsg: '',
      enhanceTestOk: false
    })
  },

  onEnhanceClose() {
    this.setData({ enhanceOpen: false })
  },

  onEnhanceField(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    const patch = {}
    patch[field] = e.detail.value
    // 表单变了，上一次的测试结论就不作数了
    if (this.data.enhanceTestMsg) {
      patch.enhanceTestMsg = ''
      patch.enhanceTestOk = false
    }
    // 接口/模型一填好就点亮状态，不必等保存。
    if (field === 'enhanceBaseUrl' || field === 'enhanceModel') {
      const base = field === 'enhanceBaseUrl' ? e.detail.value : this.data.enhanceBaseUrl
      const model = field === 'enhanceModel' ? e.detail.value : this.data.enhanceModel
      patch.enhanceReady = !!(enhance.normalizeBaseUrl(base) && String(model || '').trim())
    }
    this.setData(patch)
  },

  onEnhanceReasoningPick(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (id === this.data.enhanceReasoning) return
    this.setData({
      enhanceReasoning: id,
      enhanceTestMsg: '',
      enhanceTestOk: false
    })
  },

  onEnhanceResetPrompt() {
    this.setData({ enhancePrompt: enhance.DEFAULT_PROMPT, enhanceTestMsg: '', enhanceTestOk: false })
  },

  onEnhanceTest() {
    if (this.data.enhanceTesting) return
    const baseUrl = String(this.data.enhanceBaseUrl || '').trim()
    if (!baseUrl) {
      wx.showToast({ title: '请先填写接口地址', icon: 'none' })
      return
    }
    this.setData({ enhanceTesting: true, enhanceTestMsg: '', enhanceTestOk: false })
    enhance.test({
      baseUrl: baseUrl,
      apiKey: this.data.enhanceKey,
      model: this.data.enhanceModel,
      reasoning: this.data.enhanceReasoning
    }).then((res) => {
      if (this.destroyed) return
      const seconds = (res.ms / 1000).toFixed(1)
      const snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 24)
      this.setData({
        enhanceTesting: false,
        enhanceTestOk: true,
        enhanceTestMsg: '连接正常 · ' + seconds + 's' + (snippet ? ' · ' + snippet : '')
      })
    }).catch((err) => {
      if (this.destroyed) return
      this.setData({
        enhanceTesting: false,
        enhanceTestOk: false,
        enhanceTestMsg: util.errorText(err)
      })
    })
  },

  onEnhanceSave() {
    const baseUrl = String(this.data.enhanceBaseUrl || '').trim()
    if (baseUrl && !enhance.normalizeBaseUrl(baseUrl)) {
      wx.showToast({ title: '接口地址格式不正确', icon: 'none' })
      return
    }
    enhance.saveConfig({
      baseUrl: baseUrl,
      apiKey: this.data.enhanceKey,
      model: this.data.enhanceModel,
      reasoning: this.data.enhanceReasoning,
      systemPrompt: this.data.enhancePrompt
    })
    const ready = enhance.isReady()
    this.setData({ enhanceOpen: false, enhanceReady: ready })
    wx.showToast({ title: ready ? '已保存' : '已保存，需补全接口与模型', icon: 'none' })
  },

  onEnhanceUndo() {
    const text = this.data.enhanceUndo || ''
    if (!text) return
    this.setData({
      input: text,
      enhanceUndo: '',
      draftReady: true,
      inputHeight: inputHeightFor(text, this.data.inputFocus)
    })
    this.saveDraftSoon()
    wx.showToast({ title: '已恢复原稿', icon: 'none' })
  },

  onEnhanceUndoClose() {
    this.setData({ enhanceUndo: '' })
  },

  runEnhance() {
    if (this.data.enhancing) return
    if (!enhance.isReady()) {
      wx.showToast({ title: '请先配置增强提示词模型', icon: 'none' })
      this.openEnhanceSheet()
      return
    }
    const original = this.data.input || ''
    const text = original.trim()
    if (!text) {
      wx.showToast({ title: '先输入要增强的内容', icon: 'none' })
      return
    }
    if (text.length > 4000) {
      wx.showToast({ title: '内容过长，请分段增强', icon: 'none' })
      return
    }
    this.setData({ enhancing: true })
    enhance.run(text)
      .then((result) => {
        if (this.destroyed) return
        this.setData({ enhancing: false })
        // 增强期间用户改过草稿就不再覆盖，避免吞掉新的输入
        if ((this.data.input || '') !== original) {
          wx.showToast({ title: '输入已变更，未覆盖', icon: 'none' })
          return
        }
        this.setData({
          input: result,
          enhanceUndo: original,
          draftReady: true,
          inputHeight: inputHeightFor(result, this.data.inputFocus)
        })
        this.saveDraftSoon()
        wx.showToast({ title: '已增强', icon: 'none' })
      })
      .catch((err) => {
        if (this.destroyed) return
        this.setData({ enhancing: false })
        const status = err && err.statusCode
        const configIssue = status === 401 || status === 403 || status === 404 ||
          (err && (err.code === 'BAD_URL' || err.code === 'BAD_MODEL'))
        wx.showModal({
          title: '增强失败',
          content: util.errorText(err),
          showCancel: configIssue,
          confirmText: configIssue ? '去配置' : '知道了',
          success: (res) => {
            if (configIssue && res.confirm) this.openEnhanceSheet()
          }
        })
      })
  },

  onPickImage() {
    const remain = MAX_IMAGES - this.data.pendingImages.length
    if (remain <= 0) {
      wx.showToast({ title: '最多 ' + MAX_IMAGES + ' 张图片', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const currentTotal = this.data.pendingImages.reduce((sum, item) => sum + (item.size || 0), 0) +
          this.data.pendingFiles.reduce((sum, item) => sum + (item.size || 0), 0)
        let skipped = 0
        const added = (res.tempFiles || []).map((file) => {
          const path = file.tempFilePath
          const name = (path || '').split(/[\\/]/).pop() || 'image.jpg'
          return { path: path, name: name, size: file.size || 0 }
        }).filter((file) => {
          if (!file.path) return false
          if (file.size && file.size > MAX_IMAGE_BYTES) {
            skipped += 1
            return false
          }
          return true
        })
        const addedBytes = added.reduce((sum, item) => sum + (item.size || 0), 0)
        if (!added.length) {
          if (skipped) wx.showToast({ title: '图片超过 8MB，已忽略', icon: 'none' })
          return
        }
        if (currentTotal + addedBytes > MAX_TOTAL_ATTACH_BYTES) {
          wx.showToast({ title: '附件总大小不能超过 30MB', icon: 'none' })
          return
        }
        this.setData({
          pendingImages: this.data.pendingImages.concat(added).slice(0, MAX_IMAGES),
          draftReady: true
        })
        if (skipped) wx.showToast({ title: '已忽略超过 8MB 的图片', icon: 'none' })
      }
    })
  },

  onPickFile() {
    if (this.data.pendingFiles.length >= 3) {
      wx.showToast({ title: '最多 3 个文件', icon: 'none' })
      return
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => {
        const file = (res.tempFiles || [])[0]
        if (!file) return
        if (file.size && file.size > MAX_FILE_BYTES) {
          wx.showToast({ title: '文件超过 20MB', icon: 'none' })
          return
        }
        const currentTotal = this.data.pendingImages.reduce((sum, item) => sum + (item.size || 0), 0) +
          this.data.pendingFiles.reduce((sum, item) => sum + (item.size || 0), 0)
        if (currentTotal + (file.size || 0) > MAX_TOTAL_ATTACH_BYTES) {
          wx.showToast({ title: '附件总大小不能超过 30MB', icon: 'none' })
          return
        }
        this.setData({
          pendingFiles: this.data.pendingFiles.concat([{
            path: file.path,
            name: file.name || 'file',
            size: file.size || 0,
            type: file.type || ''
          }]).slice(0, 3),
          draftReady: true
        })
      }
    })
  },

  onPreviewPending(e) {
    const kind = e.currentTarget.dataset.kind
    if (kind !== 'image') return
    const index = Number(e.currentTarget.dataset.index)
    const images = (this.data.pendingImages || []).map((item) => item.path)
    if (!images[index]) return
    wx.previewImage({ urls: images, current: images[index] })
  },

  onRemovePending(e) {
    const kind = e.currentTarget.dataset.kind
    const index = Number(e.currentTarget.dataset.index)
    if (kind === 'image') {
      const next = this.data.pendingImages.slice()
      next.splice(index, 1)
      this.setData({
        pendingImages: next,
        draftReady: hasDraft(this.data.input, next, this.data.pendingFiles)
      })
    } else {
      const next = this.data.pendingFiles.slice()
      next.splice(index, 1)
      this.setData({
        pendingFiles: next,
        draftReady: hasDraft(this.data.input, this.data.pendingImages, next)
      })
    }
  },

  // ── voice input ────────────────────────────────────────────────────

  onVoice() {
    if (this.data.sending) {
      wx.showToast({ title: '正在发送，稍后再试', icon: 'none' })
      return
    }
    if (this.data.voiceBusy) return
    if (this.data.recording) {
      this.stopVoice()
      return
    }
    this.startVoice()
  },

  startVoice() {
    if (typeof wx.getRecorderManager !== 'function') {
      wx.showToast({ title: '当前微信版本不支持录音', icon: 'none' })
      return
    }
    if (!this.recorder) {
      const rec = wx.getRecorderManager()
      rec.onStop((res) => this.onVoiceStop(res))
      rec.onError((err) => {
        if (this.destroyed) return
        this.setData({ recording: false, voiceBusy: false })
        wx.showToast({ title: '录音失败：' + ((err && err.errMsg) || '未知错误'), icon: 'none' })
      })
      this.recorder = rec
    }
    this.setData({ recording: true, voiceBusy: false })
    this.recorder.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    })
  },

  stopVoice() {
    if (!this.recorder) return
    this.setData({ recording: false, voiceBusy: true })
    try {
      this.recorder.stop()
    } catch (e) {
      this.setData({ voiceBusy: false })
    }
  },

  onVoiceStop(res) {
    if (this.destroyed) return
    this.setData({ recording: false })
    const path = res && res.tempFilePath
    if (!path) {
      this.setData({ voiceBusy: false })
      wx.showToast({ title: '没有录到声音', icon: 'none' })
      return
    }
    const profile = this.profile ? '?profile=' + encodeURIComponent(this.profile) : ''
    this.readBase64(path)
      .then((base64) => http.authed(this.endpoint, {
        path: '/api/audio/transcribe' + profile,
        method: 'POST',
        data: { data_url: 'data:audio/mp3;base64,' + base64, mime_type: 'audio/mp3' },
        timeout: 120000
      }))
      .then((r) => {
        if (this.destroyed) return
        this.setData({ voiceBusy: false })
        if (r.statusCode === 401) {
          this.onAuthExpired()
          return
        }
        if (r.statusCode !== 200) {
          const detail = r.data && r.data.detail
          throw util.makeError('STT', typeof detail === 'string' && detail.indexOf('No STT provider') === 0
            ? '服务端未配置语音转文字（STT）'
            : '语音识别失败（HTTP ' + r.statusCode + '）')
        }
        const text = ((r.data && r.data.transcript) || '').trim()
        if (!text) {
          wx.showToast({ title: '没有识别到语音', icon: 'none' })
          return
        }
        const current = (this.data.input || '').trim()
        const next = current ? current + ' ' + text : text
        this.setData({ input: next, draftReady: true, inputHeight: inputHeightFor(next, this.data.inputFocus) })
        this.saveDraftSoon()
      })
      .catch((err) => {
        if (this.destroyed) return
        this.setData({ voiceBusy: false })
        if (err && (err.statusCode === 401 || err.code === 'AUTH' || err.code === 'AUTH_REQUIRED')) {
          this.onAuthExpired()
          return
        }
        wx.showToast({ title: util.errorText(err), icon: 'none' })
      })
  },

  onAuthExpired() {
    if (this.destroyed || this.authPrompted) return
    this.authPrompted = true
    // 续期过一次之后仍然 401：说明令牌不是过期而是被拒绝，不能再循环续期。
    if (this.authRecovered) {
      this.showAuthPrompt()
      return
    }
    // 先尝试静默续期（自动登录），失败才提示重新输入密码。
    auth.recover(this.endpoint).then(() => {
      if (this.destroyed) return
      this.authRecovered = true
      this.authPrompted = false
      this.setData({ errorBanner: '' })
      if (this.gw) {
        this.gw.connect()
          .then(() => {
            if (this.destroyed) return
            const resumed = this.syncSession()
            const after = () => this.drainQueue()
            if (resumed && typeof resumed.then === 'function') resumed.then(after, after)
            else after()
          })
          .catch(() => {})
      }
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
          this.onMenu()
          return
        }
        wx.redirectTo({ url: '/pages/endpoint-form/index?id=' + this.endpoint.id + '&relogin=1&auto=1' })
      }
    })
  },

  ensureSession() {
    if (this.runtimeId) return Promise.resolve(this.runtimeId)
    if (this.creating) return this.creating
    if (!this.gw) return Promise.reject(util.makeError('WS_CLOSED', '连接已关闭'))
    const params = { source: 'local' }
    if (this.profile) params.profile = this.profile
    if (this.cwd && (this.cwd.charAt(0) === '/' || /^[a-zA-Z]:[\\/]/.test(this.cwd))) params.cwd = this.cwd
    if (this.pendingModel) {
      params.model = this.pendingModel
      if (this.pendingProvider) params.provider = this.pendingProvider
    }
    if (this.pendingReasoning) params.reasoning_effort = this.pendingReasoning
    this.creating = this.gw.rpc('session.create', params, 60000)
      .then((res) => {
        this.runtimeId = res.session_id
        this.storedId = res.stored_session_id || this.storedId
        this.captureExecGen(res, res.info)
        // 会话刚建立时把本轮已经选好的详情/收起状态记到该会话上。
        if (this.liveDetail) writeLiveDetail(this.endpoint.id, this.storedId, true)
        if (res.cwd) this.cwd = res.cwd
        const info = res.info || {}
        this.metaRow = Object.assign({}, this.metaRow, {
          id: this.storedId,
          title: info.title || this.title,
          cwd: this.cwd,
          model: info.model || (this.metaRow && this.metaRow.model) || '',
          source: 'local',
          started_at: (this.metaRow && this.metaRow.started_at) || Date.now(),
          last_active: Date.now()
        })
        if (info.model) this.setModelInfo(info.model)
        if (res.messages && res.messages.length) {
          this.applySnapshot(res)
        }
        if (info.title) this.setTitle(info.title)
        this.pendingModel = ''
        this.pendingProvider = ''
        this.pendingReasoning = ''
        if (this.reasoningLevel) this.reasoningTouched = true
        this.applyMeta()
        this.saveLast()
        this.creating = null
        return this.runtimeId
      })
      .catch((err) => {
        this.creating = null
        throw err
      })
    return this.creating
  },

  ensureLiveSession() {
    if (this.runtimeId) return Promise.resolve(this.runtimeId)
    if (this.creating) return this.creating
    if (this.syncing) {
      return this.syncing.then(() => {
        if (this.runtimeId) return this.runtimeId
        if (this.storedId) throw util.makeError('NOT_READY', '会话尚未就绪，请稍后重试')
        return this.ensureSession()
      })
    }
    return this.ensureSession()
  },

  readBase64(path) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: path,
        encoding: 'base64',
        success: (res) => resolve(res.data),
        fail: (err) => reject(util.makeError('FILE', '读取文件失败：' + ((err && err.errMsg) || path)))
      })
    })
  },

  prepareAttachments(images, filesToSend) {
    let chain = Promise.resolve([])
    images.forEach((img) => {
      chain = chain.then((refs) => this.readBase64(img.path).then((base64) => {
        return this.gw.rpc('image.attach_bytes', {
          session_id: this.runtimeId,
          content_base64: base64,
          filename: img.name,
          ext: markdown.extOf(img.name)
        }, 90000).then((res) => {
          if (res && res.attached === false) {
            throw util.makeError('ATTACH', '图片未能附加' + (res.message ? '：' + res.message : ''))
          }
          return refs
        })
      }))
    })
    filesToSend.forEach((file) => {
      chain = chain.then((refs) => this.readBase64(file.path).then((base64) => {
        const mime = file.type || 'application/octet-stream'
        const dataUrl = 'data:' + mime + ';base64,' + base64
        return this.gw.rpc('file.attach', {
          session_id: this.runtimeId,
          data_url: dataUrl,
          name: file.name
        }, 180000).then((res) => {
          if (res && res.ref_text) return refs.concat([res.ref_text])
          return refs
        })
      }))
    })
    return chain
  },

  pushUser(text, images, fileNames, forceScroll, steered) {
    const msg = {
      id: uid('u'),
      role: 'user',
      text: text,
      images: images || [],
      files: fileNames || [],
      status: 'done',
      steer: !!steered,
      timeText: util.formatTime(Date.now())
    }
    this.msgs.push(msg)
    this.dirty = {}
    this.setData({ msgs: this.msgs.slice() })
    this.scrollToBottom(!!forceScroll)
    return msg
  },

  queueView() {
    return this.outbox.map((item) => {
      const images = (item.images || []).length
      const fileCount = (item.files || []).length
      const extra = []
      if (images) extra.push(images + ' 张图片')
      if (fileCount) extra.push(fileCount + ' 个文件')
      return {
        id: item.id,
        preview: cut(String(item.text || '').trim(), 120) || '附件消息',
        attachText: extra.join(' · '),
        sending: item.id === this.drainingId
      }
    })
  },

  refreshQueue() {
    const patch = { queue: this.queueView() }
    if (!this.outbox.length && this.data.queuePaused) patch.queuePaused = false
    this.setData(patch)
  },

  enqueueDraft(text, images, fileList) {
    this.outbox.push({
      id: uid('q'),
      text: text,
      images: images.slice(),
      files: fileList.slice()
    })
    const current = String(this.data.input || '')
    // 排队可能发生在异步失败之后：这时用户可能已经重新敲了新内容，
    // 只有输入框仍为空或仍是刚提交的这段文字时才清空，避免把新输入吞掉。
    const clearInput = !current.trim() || samePromptText(current, text)
    const patch = {
      pendingImages: [],
      pendingFiles: [],
      draftReady: false,
      queuePaused: false,
      // 已排队的消息不能再“撤销改写”回输入框，否则会重复投递。
      enhanceUndo: ''
    }
    if (clearInput) {
      patch.input = ''
      patch.inputHeight = INPUT_MIN
      patch.inputFocus = false
      drafts.clear(this.draftKey())
      this.resetInputHistory('')
    } else {
      patch.draftReady = hasDraft(current, [], [])
    }
    if (!this.data.fullscreen) patch.inputFocus = false
    this.setData(patch)
    this.refreshQueue()
    try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* ignore */ }
    wx.showToast({ title: '已加入队列', icon: 'none' })
  },

  // 发送成功后统一清空输入区，保留全屏开关本身的状态。
  clearComposer() {
    this.setData({
      input: '',
      inputHeight: INPUT_MIN,
      pendingImages: [],
      pendingFiles: [],
      draftReady: false,
      inputFocus: false,
      enhanceUndo: ''
    })
    this.resetInputHistory('')
  },

  removeQueued(id) {
    const idx = this.outbox.findIndex((item) => item.id === id)
    if (idx < 0) return
    this.outbox.splice(idx, 1)
    this.refreshQueue()
  },

  onQueueRemove(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    if (this.draining && this.drainingId === id) {
      wx.showToast({ title: '正在发送，请稍候', icon: 'none' })
      return
    }
    this.removeQueued(id)
  },

  onQueueResume() {
    if (!this.outbox.length) return
    if (!this.gw || !this.gw.isOpen()) {
      wx.showToast({ title: '连接未就绪，请稍后重试', icon: 'none' })
      return
    }
    this.setData({ queuePaused: false })
    this.drainQueue()
  },

  drainQueue() {
    if (this.destroyed || this.draining || !this.outbox.length) return
    if (this.data.queuePaused || this.data.streaming || this.data.sending) return
    if (!this.gw || !this.gw.isOpen()) return
    const item = this.outbox[0]
    this.draining = true
    this.drainingId = item.id
    this.refreshQueue()
    this.submitPrompt(item.text, item.images.slice(), item.files.slice(), true, item)
  },

  submitPrompt(text, images, fileList, fromQueue, item) {
    const oldDraftKey = this.draftKey()
    const inputText = this.data.input
    const pendingImages = this.data.pendingImages.slice()
    const pendingFiles = this.data.pendingFiles.slice()
    const seqBefore = this.turnSeq || 0
    let pushed = null

    const patch = { sending: true }
    if (!fromQueue) {
      patch.input = ''
      patch.inputHeight = INPUT_MIN
      patch.pendingImages = []
      patch.pendingFiles = []
      patch.draftReady = false
      patch.inputFocus = false
      patch.enhanceUndo = ''
      this.resetInputHistory('')
    }
    this.setData(patch)
    if (!fromQueue) {
      drafts.clear(oldDraftKey)
      // 发送即回底：不等会话/附件就绪，先把视线落回最新位置
      this.scrollToBottom(true)
    }

    this.ensureSession()
      .then(() => this.prepareAttachments(images, fileList))
      .then((refs) => {
        const bodyText = [text].concat(refs || []).filter(Boolean).join('\n\n')
        pushed = this.pushUser(text, images.map((i) => i.path), fileList.map((f) => f.name), !fromQueue)
        const params = { session_id: this.runtimeId, text: bodyText }
        // A queue drain waits for the next turn; it must never steer or interrupt the live one.
        if (fromQueue) params.queued = true
        // 事件可能早于 ACK 到达：先把这一回合标成本机发起，避免误判为「其他端」。
        this.turnLocal = true
        this.localTurnAt = Date.now()
        return this.gw.rpc('prompt.submit', params, 30000)
      })
      .then((res) => {
        this.draining = false
        this.drainingId = ''
        if (this.destroyed) return
        this.captureExecGen(res, res && res.info)
        const serverQueued = !!(res && res.status === 'queued')
        const endedEarly = (this.turnSeq || 0) !== seqBefore
        if (fromQueue && item) this.removeQueued(item.id)
        this.setData({ sending: false })
        if (serverQueued) {
          this.turnLocal = false
          this.addNotice('上一条仍在收尾，这条已排队')
          return
        }
        if (endedEarly) {
          // The turn started and finished before this ACK arrived; do not mint a ghost bubble.
          this.turnLocal = false
          this.setData({ streaming: false, remoteTurn: false })
          this.drainQueue()
          return
        }
        this.turnLocal = true
        this.localTurnAt = Date.now()
        this.setData({ streaming: true, remoteTurn: false })
        this.ensureStream()
        this.scrollToBottom()
      })
      .catch((err) => {
        this.draining = false
        this.drainingId = ''
        this.turnLocal = false
        if (this.destroyed) return
        if (pushed) {
          const idx = this.msgs.indexOf(pushed)
          if (idx >= 0) this.msgs.splice(idx, 1)
          this.dirty = {}
        }
        if (fromQueue) {
          this.setData({ sending: false, msgs: this.msgs.slice(), queuePaused: true })
          this.refreshQueue()
          this.addNotice('队列发送失败：' + util.errorText(err) + '，队列已暂停', 'error')
          return
        }
        const currentInput = this.data.input || ''
        const mergedInput = currentInput.trim() ? inputText + '\n\n' + currentInput : inputText
        const mergedImages = pendingImages.concat(this.data.pendingImages)
        const mergedFiles = pendingFiles.concat(this.data.pendingFiles)
        this.setData({
          sending: false,
          msgs: this.msgs.slice(),
          input: mergedInput,
          inputHeight: inputHeightFor(mergedInput, false),
          pendingImages: mergedImages.slice(0, MAX_IMAGES),
          pendingFiles: mergedFiles.slice(0, 3),
          draftReady: hasDraft(mergedInput, mergedImages, mergedFiles)
        })
        this.saveDraftSoon()
        this.addNotice('发送失败：' + util.errorText(err), 'error')
      })
  },

  onSend() {
    const text = (this.data.input || '').trim()
    const images = this.data.pendingImages.slice()
    const filesToSend = this.data.pendingFiles.slice()
    if (!hasDraft(text, images, filesToSend)) return
    if (!this.gw || !this.gw.isOpen()) {
      wx.showToast({ title: '连接未就绪', icon: 'none' })
      return
    }
    if (this.data.streaming || this.data.sending || this.draining) {
      if (this.busyMode === 'steer') {
        if (images.length || filesToSend.length) {
          wx.showToast({ title: '插入模式仅支持纯文本', icon: 'none' })
          this.enqueueDraft(text, images, filesToSend)
          return
        }
        this.steerSend(text, (reason) => {
          this.enqueueDraft(text, images, filesToSend)
          this.addNotice(reason)
        })
        return
      }
      this.enqueueDraft(text, images, filesToSend)
      return
    }
    this.submitPrompt(text, images, filesToSend, false, null)
  },

  onToggleBusyMode() {
    const next = this.busyMode === 'steer' ? 'queue' : 'steer'
    this.busyMode = next
    this.setData({ busyMode: next })
    if (this.endpoint) store.setSettings(this.endpoint.id, { busyMode: next })
    try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* ignore */ }
  },

  // 部分版本只在 resume 投影里给 execution_generation；插入前补读一次。
  fetchExecGen() {
    if (this.hasExecGen()) return Promise.resolve(true)
    if (!this.storedId || !this.gw || !this.gw.isOpen()) return Promise.resolve(false)
    if (this.syncing) return this.syncing.then(() => this.hasExecGen(), () => false)
    const params = { session_id: this.storedId, inline_images: false }
    if (this.profile) params.profile = this.profile
    return this.gw.rpc('session.resume', params, 30000)
      .then((snap) => {
        if (!snap) return false
        this.captureExecGen(snap, snap.info)
        if (snap.session_id) this.runtimeId = snap.session_id || this.runtimeId
        return this.hasExecGen()
      })
      .catch(() => false)
  },

  // session.steer injects into the live turn without interrupting it. 任何拒绝都
  // 降级为排队，保证「插入」这条输入永远不会凭空消失。
  steerSend(text, fallback) {
    if (!this.gw || !this.gw.isOpen()) {
      fallback('连接已关闭，已改为排队')
      return
    }
    if (this.steering) {
      // 上一条插入还在途中：先排队，避免快速连发时静默丢字。
      fallback('上一条插入正在发送，已改为排队')
      return
    }
    const sessionId = this.runtimeId || this.storedId
    if (!sessionId) {
      fallback('会话尚未就绪，已改为排队')
      return
    }

    this.steering = true
    this.setData({ sending: true })
    const draftKey = this.draftKey()
    this.clearComposer()
    drafts.clear(draftKey)
    const pushed = this.pushUser(text, [], [], true, true)

    const paramsFor = (gen) => {
      const params = { session_id: sessionId, text: text }
      if (gen !== undefined && gen !== null && gen !== '') params.execution_generation = gen
      // 文档要求 profile 与 authority 一致；带上当前会话的 profile。
      if (this.profile) params.profile = this.profile
      return params
    }

    const finish = (message) => {
      this.steering = false
      if (this.destroyed) return
      this.setData({ sending: false })
      if (message) fallback(message)
    }

    const staleError = (err) => {
      const text = String((err && (err.message || err.errMsg || err.code || err.rpcCode)) || '')
      return /generation|stale/i.test(text)
    }

    const request = (retried) => {
      const gen = this.hasExecGen() ? this.execGen : undefined
      const retry = () => this.refreshExecGen().then((ok) => (ok ? request(true) : null))
      return this.gw.rpc('session.steer', paramsFor(gen), 15000).then((res) => {
        if (this.destroyed) return null
        this.captureExecGen(res, res && res.info)
        if (steerStatus(res) === 'stale_generation' && !retried) {
          // 代次过期不代表插不进去：补读一次当前回合序号后原样重试。
          return retry().then((next) => (next === null ? res : next))
        }
        return res
      }, (err) => {
        // 部分版本把 stale_generation 作为 RPC 错误返回，同样重试一次。
        if (!retried && staleError(err)) {
          return retry().then((next) => {
            if (next !== null) return next
            throw err
          })
        }
        throw err
      })
    }

    request(false)
      .then((res) => {
        if (this.destroyed) return
        if (!steerAccepted(res)) {
          this.dropMsg(pushed)
          const status = steerStatus(res)
          if (status === 'stale_generation') finish('回合代次已变化，已改为排队')
          else if (status === 'unsupported_control') finish('当前模式不支持插入，已改为排队')
          else finish('当前回合不接受插入，已改为排队')
          return
        }
        this.steering = false
        this.setData({ sending: false })
        const status = steerStatus(res)
        if (status === 'redirected') {
          // 服务端按新指示重开了本回合：旧气泡收尾，后续输出落到新气泡。
          this.finalizeStream('done')
          this.turnLocal = true
          this.localTurnAt = Date.now()
        }
        try { wx.vibrateShort({ type: 'light' }) } catch (e) { /* ignore */ }
        this.addNotice(status === 'redirected' ? '已插入，本回合将按新指示继续'
          : (status === 'queued' ? '已加入当前回合，将在下一步执行' : '已插入当前回合'))
      })
      .catch((err) => {
        if (this.destroyed) return
        this.dropMsg(pushed)
        finish('插入失败：' + util.errorText(err) + '，已改为排队')
      })
  },

  // 插入被拒后重读一次代次；事件里没带代次时也走这里。
  refreshExecGen() {
    this.execGen = null
    return this.fetchExecGen()
  },

  dropMsg(msg) {
    if (!msg) return
    const idx = this.msgs.indexOf(msg)
    if (idx >= 0) this.msgs.splice(idx, 1)
    this.dirty = {}
    this.setData({ msgs: this.msgs.slice() })
  },

  onStop() {
    const sessionId = this.runtimeId || this.storedId
    if (!this.gw || !sessionId) return
    const hasQueue = this.outbox.length > 0
    if (hasQueue) {
      this.setData({ queuePaused: true })
      this.refreshQueue()
    }
    this.gw.rpc('session.interrupt', { session_id: sessionId }, 10000)
      .then(() => {
        if (!this.destroyed) this.addNotice(hasQueue ? '已请求停止，队列已暂停' : '已请求停止')
      })
      .catch((err) => {
        if (!this.destroyed) wx.showToast({ title: util.errorText(err), icon: 'none' })
      })
  }
})
