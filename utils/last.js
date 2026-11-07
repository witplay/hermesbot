const KEY = 'hermes.last.v1'

function read() {
  try {
    const all = wx.getStorageSync(KEY)
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch (e) {
    return {}
  }
}

function get(endpointId) {
  const entry = read()[endpointId]
  return entry && entry.id ? entry : null
}

function set(endpointId, session) {
  if (!endpointId || !session || !session.id) return
  const all = read()
  all[endpointId] = {
    id: session.id,
    title: session.title || '',
    cwd: session.cwd || '',
    profile: session.profile || '',
    at: Date.now()
  }
  try { wx.setStorageSync(KEY, all) } catch (e) { /* ignore */ }
}

function clear(endpointId) {
  const all = read()
  if (!all[endpointId]) return
  delete all[endpointId]
  try { wx.setStorageSync(KEY, all) } catch (e) { /* ignore */ }
}

module.exports = { get, set, clear }
