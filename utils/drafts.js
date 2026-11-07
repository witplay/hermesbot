const KEY = 'hermes.drafts.v1'

function read() {
  try {
    const all = wx.getStorageSync(KEY)
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch (e) {
    return {}
  }
}

function write(all) {
  try { wx.setStorageSync(KEY, all) } catch (e) { /* ignore */ }
}

function key(endpointId, sid, cwd) {
  if (sid) return endpointId + ':s:' + sid
  return endpointId + ':n:' + (cwd || '')
}

function snapshot() {
  return read()
}

function get(storeKey, all) {
  const map = all || read()
  return typeof map[storeKey] === 'string' ? map[storeKey] : ''
}

function set(storeKey, text) {
  const all = read()
  const value = String(text == null ? '' : text)
  if (!value.trim()) delete all[storeKey]
  else all[storeKey] = value
  write(all)
}

function clear(storeKey) {
  const all = read()
  if (all[storeKey] === undefined) return
  delete all[storeKey]
  write(all)
}

function has(storeKey, all) {
  const map = all || read()
  return typeof map[storeKey] === 'string' && map[storeKey].trim().length > 0
}

// Removing a site or a session must not leave its draft text behind on disk.
function clearEndpoint(endpointId) {
  if (!endpointId) return
  const all = read()
  const prefix = endpointId + ':'
  let changed = false
  Object.keys(all).forEach((storeKey) => {
    if (storeKey.indexOf(prefix) === 0) {
      delete all[storeKey]
      changed = true
    }
  })
  if (changed) write(all)
}

module.exports = { key, snapshot, get, set, clear, has, clearEndpoint }
