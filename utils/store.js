const last = require('./last')
const drafts = require('./drafts')

const ENDPOINTS_KEY = 'hermes.endpoints.v1'
const ACTIVE_KEY = 'hermes.active.v1'
const AUTH_PREFIX = 'hermes.auth.v1.'
const SETTINGS_PREFIX = 'hermes.settings.v1.'

function isValidBaseUrl(url) {
  const value = String(url || '')
  if (!/^https?:\/\//i.test(value)) return false
  if (/\s/.test(value)) return false
  const m = value.match(/^https?:\/\/(\[[^\]]+\]|[^/?#:]+)(?::(\d{1,5}))?(?:[/?#]|$)/i)
  if (!m) return false
  if (m[2]) {
    const port = Number(m[2])
    if (!port || port > 65535) return false
  }
  return true
}

function normalizeUrl(raw) {
  let url = String(raw || '').trim()
  if (!url) return ''
  url = url.replace(/^ws(s?):\/\//i, 'http$1://')
  // Reject explicitly unsupported schemes instead of turning "ftp://x" into
  // "https://ftp://x", which used to pass the form's prefix check.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) return ''
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  url = url.replace(/\/+$/, '')
  return isValidBaseUrl(url) ? url : ''
}

function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?/i)
  if (!m) return ''
  return m[1] + (m[2] ? ':' + m[2] : '')
}

function originOf(url) {
  const m = String(url || '').match(/^(https?):\/\/(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?/i)
  if (!m) return ''
  return m[1].toLowerCase() + '://' + m[2] + (m[3] ? ':' + m[3] : '')
}

function wsUrl(baseUrl, path) {
  const ws = String(baseUrl || '').replace(/^http/i, 'ws')
  return ws + (path || '/api/ws')
}

function readList() {
  try {
    const list = wx.getStorageSync(ENDPOINTS_KEY)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function writeList(list) {
  try {
    wx.setStorageSync(ENDPOINTS_KEY, list)
    return true
  } catch (e) {
    return false
  }
}

function list() {
  return readList().slice().sort((a, b) => {
    const la = a.lastUsedAt || 0
    const lb = b.lastUsedAt || 0
    if (la !== lb) return lb - la
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

function get(id) {
  const list = readList()
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i]
  }
  return null
}

function save(endpoint) {
  const source = endpoint && typeof endpoint === 'object' ? endpoint : {}
  const list = readList()
  const next = Object.assign({}, source)
  next.baseUrl = normalizeUrl(next.baseUrl)
  if (!next.baseUrl) throw new Error('服务地址格式不正确')
  if (!next.id) {
    next.id = 'ep_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    next.createdAt = Date.now()
  }
  const idx = list.findIndex((e) => e.id === next.id)
  const prev = idx >= 0 ? list[idx] : null
  // An omitted label keeps the previous one; an explicitly cleared label falls
  // back to the host, matching the old behaviour for the form.
  const rawLabel = next.label === undefined ? (prev ? prev.label : '') : next.label
  next.label = String(rawLabel || '').trim() || hostOf(next.baseUrl) || 'Hermes'
  next.updatedAt = Date.now()
  // A bearer token is bound to its origin (scheme + host + port). Never send an
  // old token to a different origin after the user edits the server address.
  const hostChanged = !!(prev && originOf(prev.baseUrl) !== originOf(next.baseUrl))
  if (idx >= 0) list[idx] = Object.assign({}, list[idx], next)
  else list.push(next)
  if (!writeList(list)) throw new Error('保存站点失败，请清理存储空间后重试')
  if (hostChanged) clearAuth(next.id)
  const result = Object.assign({}, next)
  if (hostChanged) result.authCleared = true
  return result
}

function remove(id) {
  const next = readList().filter((e) => e.id !== id)
  if (!writeList(next)) return false
  clearAuth(id)
  try { wx.removeStorageSync(SETTINGS_PREFIX + id) } catch (e) { /* ignore */ }
  last.clear(id)
  drafts.clearEndpoint(id)
  if (getActiveId() === id) setActiveId('')
  return true
}

function touch(id) {
  const list = readList()
  const idx = list.findIndex((e) => e.id === id)
  if (idx < 0) return
  list[idx].lastUsedAt = Date.now()
  writeList(list)
}

function getActiveId() {
  try {
    const id = wx.getStorageSync(ACTIVE_KEY)
    return typeof id === 'string' ? id : ''
  } catch (e) {
    return ''
  }
}

function setActiveId(id) {
  try { wx.setStorageSync(ACTIVE_KEY, id || '') } catch (e) { /* ignore */ }
}

function getAuth(id) {
  try {
    const auth = wx.getStorageSync(AUTH_PREFIX + id)
    return auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : null
  } catch (e) {
    return null
  }
}

function setAuth(id, auth) {
  try {
    wx.setStorageSync(AUTH_PREFIX + id, auth)
    return true
  } catch (e) {
    return false
  }
}

function clearAuth(id) {
  try { wx.removeStorageSync(AUTH_PREFIX + id) } catch (e) { /* ignore */ }
}

function getSettings(id) {
  try {
    const settings = wx.getStorageSync(SETTINGS_PREFIX + id)
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  } catch (e) {
    return {}
  }
}

function setSettings(id, patch) {
  const next = Object.assign({}, getSettings(id), patch)
  try { wx.setStorageSync(SETTINGS_PREFIX + id, next) } catch (e) { /* ignore */ }
  return next
}

function migrate() {
  const items = list()
  const active = getActiveId()
  const exists = active && items.some((item) => item.id === active)
  if (!exists) setActiveId(items.length ? items[0].id : '')
}

module.exports = {
  normalizeUrl,
  isValidBaseUrl,
  hostOf,
  wsUrl,
  list,
  get,
  save,
  remove,
  touch,
  getActiveId,
  setActiveId,
  getAuth,
  setAuth,
  clearAuth,
  getSettings,
  setSettings,
  migrate
}
