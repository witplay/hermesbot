const util = require('./util')

const COOKIE_KEYS = ['Set-Cookie', 'set-cookie', 'SET-COOKIE']

function splitSetCookie(headers) {
  if (!headers) return []
  let raw = null
  for (let i = 0; i < COOKIE_KEYS.length; i++) {
    if (headers[COOKIE_KEYS[i]]) {
      raw = headers[COOKIE_KEYS[i]]
      break
    }
  }
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  // Multiple cookies arrive either comma-joined or newline-joined. A comma inside
  // an Expires attribute is not followed by "name=", so this split is safe.
  return String(raw).split(/,(?=\s*[^;,=\s]+=)|\n/).filter((s) => s.trim())
}

function parseCookie(raw) {
  const parts = String(raw).split(';')
  const pair = parts.shift() || ''
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const out = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    maxAge: 0,
    hasMaxAge: false
  }
  parts.forEach((attr) => {
    const m = attr.match(/^\s*max-age\s*=\s*(-?\d+)\s*$/i)
    if (m) {
      out.maxAge = parseInt(m[1], 10)
      out.hasMaxAge = true
    }
  })
  return out
}

function captureCookies(jar, headers) {
  if (!jar) return
  splitSetCookie(headers).forEach((item) => {
    const cookie = parseCookie(item)
    if (!cookie) return
    // Max-Age=0 is an explicit deletion; a cookie without Max-Age is a session
    // cookie and must stay in the jar for the rest of this login flow.
    if (cookie.hasMaxAge && cookie.maxAge <= 0) delete jar[cookie.name]
    else if (cookie.maxAge < 0) delete jar[cookie.name]
    else jar[cookie.name] = cookie.value
  })
}

function cookieHeader(jar) {
  if (!jar) return ''
  const keys = Object.keys(jar)
  if (!keys.length) return ''
  return keys.map((k) => k + '=' + jar[k]).join('; ')
}

function cookieValue(headers, suffixes) {
  const found = splitSetCookie(headers)
  for (let i = 0; i < found.length; i++) {
    const cookie = parseCookie(found[i])
    if (!cookie) continue
    for (let j = 0; j < suffixes.length; j++) {
      if (cookie.name === suffixes[j] || cookie.name.endsWith('-' + suffixes[j])) {
        return cookie
      }
    }
  }
  return null
}

// The dashboard writes its bearer tokens as session cookies when the native PKCE
// broker cookie is absent (wx.request does not persist that cookie). Names are
// bare over HTTP, __Host- over HTTPS, __Secure- behind a proxy prefix.
function sessionFromSetCookie(headers) {
  const at = cookieValue(headers, ['hermes_session_at'])
  const rt = cookieValue(headers, ['hermes_session_rt'])
  const provider = cookieValue(headers, ['hermes_session_provider'])
  const now = Math.floor(Date.now() / 1000)
  return {
    accessToken: at ? at.value : '',
    refreshToken: rt ? rt.value : '',
    provider: provider ? provider.value : '',
    expiresAt: at && at.maxAge > 0 ? now + at.maxAge : 0
  }
}

function raw(endpoint, opts) {
  const options = opts || {}
  const header = { 'Content-Type': 'application/json' }
  if (options.jar) {
    const cookie = cookieHeader(options.jar)
    if (cookie) header.Cookie = cookie
  }
  Object.assign(header, options.headers || {})

  return new Promise((resolve, reject) => {
    wx.request({
      url: endpoint.baseUrl + (options.path || ''),
      method: options.method || 'GET',
      data: options.data,
      header,
      timeout: options.timeout || 30000,
      success(res) {
        captureCookies(options.jar, res.header)
        resolve({ statusCode: res.statusCode, data: res.data, header: res.header || {} })
      },
      fail(err) {
        reject(util.makeError('NETWORK', (err && err.errMsg) || '网络请求失败', { cause: err }))
      }
    })
  })
}

function withAuth(opts, token) {
  const next = Object.assign({}, opts)
  next.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token })
  return next
}

function authed(endpoint, opts) {
  const auth = require('./auth')
  return auth.ensureToken(endpoint)
    .then((token) => raw(endpoint, withAuth(opts, token)))
    .then((res) => {
      if (res.statusCode !== 401) return res
      return auth.refresh(endpoint).then((next) => raw(endpoint, withAuth(opts, next.accessToken)))
    })
}

module.exports = { raw, authed, splitSetCookie, parseCookie, sessionFromSetCookie }
