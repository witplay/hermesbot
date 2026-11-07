const http = require('./http')
const store = require('./store')
const util = require('./util')
const sha256Module = require('./sha256')

const AUTH_REQUIRED = 'AUTH_REQUIRED'
const REFRESH_MARGIN_MS = 120000
const refreshing = {}

function authError() {
  return util.makeError(AUTH_REQUIRED, '登录已过期，请重新登录')
}

function hasToken(endpoint) {
  const auth = store.getAuth(endpoint.id)
  return !!(auth && auth.accessToken)
}

function saveSession(endpoint, body, previous) {
  if (!body || !body.access_token) {
    throw util.makeError('LOGIN_FAILED', '服务端未返回访问令牌')
  }
  const prev = previous || store.getAuth(endpoint.id) || {}
  const expiresIn = Number(body.expires_in)
  const expiresAt = body.expires_at ||
    (isFinite(expiresIn) && expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0)
  const auth = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || prev.refreshToken || '',
    expiresAt: expiresAt,
    userId: body.user_id || prev.userId || '',
    provider: body.provider || prev.provider || 'basic',
    updatedAt: Date.now()
  }
  if (!store.setAuth(endpoint.id, auth)) {
    throw util.makeError('STORAGE', '登录信息保存失败，请清理存储空间后重试')
  }
  return auth
}

function confirmSession(endpoint, auth) {
  return http.raw(endpoint, {
    path: '/api/auth/me',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + auth.accessToken },
    timeout: 10000
  }).then((res) => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      store.clearAuth(endpoint.id)
      throw util.makeError('LOGIN_FAILED', '登录令牌未被接受，请确认账号权限')
    }
    if (res.statusCode === 200 && res.data) {
      if (res.data.expires_at) auth.expiresAt = res.data.expires_at
      if (res.data.user_id) auth.userId = res.data.user_id
      if (res.data.provider) auth.provider = res.data.provider
      auth.verified = true
      store.setAuth(endpoint.id, auth)
    } else {
      // 5xx / 404 / a malformed body must not be reported as a verified login,
      // but the token is kept so a temporary dashboard failure does not force a
      // second password prompt.
      auth.verified = false
    }
    store.touch(endpoint.id)
    return auth
  }, () => {
    auth.verified = false
    store.touch(endpoint.id)
    return auth
  })
}

// The dashboard only returns a PKCE loopback code when its broker cookie rides
// along on the password POST. wx.request does not persist cookies, so carry a
// manual jar through authorize -> password-login -> token exchange, and also
// accept bearer tokens returned directly in the response body.
function login(endpoint, username, password) {
  return util.randomBytes(32).then((verifierBytes) => {
    const verifier = util.base64url(verifierBytes)
    const challenge = util.base64url(sha256Module.sha256(util.utf8(verifier)))
    const redirectUri = 'http://127.0.0.1:53682/callback'
    const state = util.base64url(util.randomBytesSync(8))
    const query = [
      'provider=basic',
      'code_challenge=' + encodeURIComponent(challenge),
      'code_challenge_method=S256',
      'redirect_uri=' + encodeURIComponent(redirectUri),
      'state=' + state
    ].join('&')
    const jar = {}

    return http.raw(endpoint, {
      path: '/auth/native/authorize?' + query,
      method: 'GET',
      jar: jar,
      timeout: 15000
    })
      .catch(() => null)
      .then(() => http.raw(endpoint, {
        path: '/auth/password-login',
        method: 'POST',
        jar: jar,
        data: { provider: 'basic', username: username, password: password },
        timeout: 20000
      }))
      .then((res) => {
        const body = res.data || {}
        if (res.statusCode === 429) {
          throw util.makeError('RATE_LIMITED', '尝试次数过多，请稍后再试')
        }
        if (res.statusCode === 401) {
          throw util.makeError('LOGIN_FAILED', '账号或密码不正确')
        }
        if (res.statusCode === 404) {
          throw util.makeError('LOGIN_FAILED', '服务地址或路径不正确，或该 Hermes 未启用密码登录（HTTP 404）')
        }
        if (res.statusCode !== 200 || (!body.ok && !body.access_token)) {
          const detail = body.detail || body.error || ('HTTP ' + res.statusCode)
          throw util.makeError('LOGIN_FAILED', '登录失败（' + detail + '）')
        }

        const returnedState = util.parseQuery(body.next || '', 'state')
        if (returnedState && returnedState !== state) {
          throw util.makeError('LOGIN_FAILED', '登录状态校验失败，请重试')
        }

        // Prefer a body token when the dashboard exposes one; this avoids the
        // platform-dependent Set-Cookie visibility issue entirely.
        if (body.access_token) return saveSession(endpoint, body)

        const code = util.parseQuery(body.next || '', 'code')
        if (code) {
          return http.raw(endpoint, {
            path: '/auth/native/token',
            method: 'POST',
            jar: jar,
            data: { code: code, code_verifier: verifier },
            timeout: 20000
          }).then((tokenRes) => {
            const tokens = tokenRes.data || {}
            if (tokenRes.statusCode !== 200 || !tokens.access_token) {
              throw util.makeError('LOGIN_FAILED', '令牌换取失败（HTTP ' + tokenRes.statusCode + '）')
            }
            return saveSession(endpoint, tokens)
          })
        }

        const session = http.sessionFromSetCookie(res.header)
        if (!session.accessToken) {
          throw util.makeError('LOGIN_FAILED', '登录成功但客户端未取到令牌：微信未回传 Cookie，请更新微信后重试')
        }
        return saveSession(endpoint, {
          access_token: session.accessToken,
          refresh_token: session.refreshToken,
          expires_at: session.expiresAt,
          provider: session.provider || 'basic'
        })
      })
      .then((auth) => confirmSession(endpoint, auth))
  })
}

function refresh(endpoint) {
  if (refreshing[endpoint.id]) return refreshing[endpoint.id]
  const current = store.getAuth(endpoint.id)
  if (!current || !current.refreshToken) return Promise.reject(authError(endpoint))

  const promise = http.raw(endpoint, {
    path: '/auth/native/refresh',
    method: 'POST',
    data: { refresh_token: current.refreshToken, provider: current.provider || 'basic' },
    timeout: 20000
  }).then((res) => {
    const body = res.data || {}
    if (res.statusCode === 200 && body.access_token) {
      return saveSession(endpoint, body, current)
    }
    if (res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403) {
      store.clearAuth(endpoint.id)
      throw authError(endpoint)
    }
    // A 500/429 must not log the user out; the caller can retry while the
    // current access token is still valid.
    throw util.makeError('AUTH_TEMP', '登录服务暂时不可用（HTTP ' + res.statusCode + '）', {
      statusCode: res.statusCode
    })
  })

  refreshing[endpoint.id] = promise
  const clear = () => { delete refreshing[endpoint.id] }
  promise.then(clear, clear)
  return promise
}

function ensureToken(endpoint) {
  const auth = store.getAuth(endpoint.id)
  if (!auth || !auth.accessToken) return Promise.reject(authError(endpoint))
  const expiresMs = Number(auth.expiresAt || 0) * 1000
  if (!expiresMs || expiresMs - Date.now() > REFRESH_MARGIN_MS) {
    return Promise.resolve(auth.accessToken)
  }
  return refresh(endpoint).then((next) => next.accessToken).catch((err) => {
    const temporary = err && (err.code === 'AUTH_TEMP' || err.code === 'NETWORK')
    if (temporary && (!expiresMs || expiresMs > Date.now())) return auth.accessToken
    throw err
  })
}

// 静默恢复登录：优先用 refresh token 换新令牌，没有 refresh token 时验证
// 当前令牌是否仍然有效。只有服务端明确拒绝凭证时才失败，网络抖动等临时
// 问题保留本地登录状态，避免用户被无谓地要求重新输入密码。
function recover(endpoint) {
  const current = store.getAuth(endpoint.id)
  if (!current || !current.accessToken) return Promise.reject(authError(endpoint))
  if (current.refreshToken) {
    return refresh(endpoint).catch((err) => {
      const temporary = err && (err.code === 'AUTH_TEMP' || err.code === 'NETWORK')
      if (temporary) return current
      throw err
    })
  }
  return confirmSession(endpoint, current).then((session) => {
    if (session.verified) return session
    throw util.makeError('AUTH_TEMP', '暂时无法验证登录状态')
  })
}

function check(endpoint) {
  return http.authed(endpoint, { path: '/api/auth/me', timeout: 10000 })
    .then((res) => ({ ok: res.statusCode === 200, statusCode: res.statusCode, me: res.data }))
    .catch((err) => ({
      ok: false,
      statusCode: err && err.statusCode,
      code: err && err.code,
      error: err
    }))
}

function logout(endpoint) {
  store.clearAuth(endpoint.id)
}

module.exports = {
  AUTH_REQUIRED,
  hasToken,
  login,
  refresh,
  recover,
  ensureToken,
  check,
  logout
}
