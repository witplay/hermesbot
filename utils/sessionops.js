const Gateway = require('./gateway')
const http = require('./http')
const util = require('./util')

// Session archive/delete live on the WS surface: the REST PATCH/DELETE on the
// launch home is forwarded to the gateway owner, which cannot resolve sessions
// created by the serve process (it answers 404 not_found).
function run(endpoint, method, params) {
  const gw = new Gateway(endpoint, {})
  return gw.connect()
    .then(() => gw.rpc(method, params, 20000))
    .then(
      (result) => {
        gw.close()
        return result
      },
      (err) => {
        gw.close()
        throw err
      }
    )
}

function archive(endpoint, sessionId, profile) {
  const params = { session_id: sessionId, archived: true }
  if (profile) params.profile = profile
  return run(endpoint, 'session.archive', params)
}

function remove(endpoint, sessionId, profile) {
  const params = { session_id: sessionId }
  if (profile) params.profile = profile
  return run(endpoint, 'session.delete', params)
}

function hasContent(row) {
  return (Number(row.message_count) || 0) > 0 ||
    String(row.title || '').trim().length > 0 ||
    String(row.preview || '').trim().length > 0
}

function list(endpoint, profile, limit, offset) {
  let path = '/api/sessions?limit=' + (limit || 100)
  if (offset) path += '&offset=' + offset
  path += '&order=recent&archived=exclude&min_messages=1'
  if (profile) path += '&profile=' + encodeURIComponent(profile)
  return http.authed(endpoint, { path: path, timeout: 25000 }).then((res) => {
    if (res.statusCode === 401) {
      throw util.makeError('AUTH', '登录已过期，请重新登录', { statusCode: 401 })
    }
    if (res.statusCode !== 200) {
      throw util.makeError('HTTP', '加载会话失败（HTTP ' + res.statusCode + '）', { statusCode: res.statusCode })
    }
    const body = res.data || {}
    const sessions = (body.sessions || []).filter(hasContent)
    return { sessions: sessions, total: body.total || sessions.length }
  })
}

module.exports = {
  run,
  archive,
  remove,
  list
}
