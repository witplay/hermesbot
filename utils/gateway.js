const auth = require('./auth')
const store = require('./store')
const util = require('./util')

const PING_INTERVAL_MS = 25000
const MAX_RECONNECT_DELAY_MS = 30000

function firstDefined(values) {
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

class Gateway {
  constructor(endpoint, handlers) {
    this.endpoint = endpoint
    this.handlers = handlers || {}
    this.task = null
    this.state = 'idle'
    this.pending = {}
    this.openRequests = {}
    this.nextId = 1
    this.pingTimer = null
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.manualClose = false
    this.connecting = null
  }

  _emit(name) {
    const fn = this.handlers[name]
    if (typeof fn !== 'function') return
    try {
      fn.apply(null, Array.prototype.slice.call(arguments, 1))
    } catch (e) {
      // A UI callback must never break the socket message loop.
    }
  }

  _setState(state) {
    if (this.state === state) return
    this.state = state
    this._emit('onState', state)
  }

  _failPending(code, message) {
    Object.keys(this.pending).forEach((id) => {
      const entry = this.pending[id]
      if (!entry) return
      delete this.pending[id]
      clearTimeout(entry.timer)
      entry.reject(util.makeError(code, message))
    })
  }

  _id() {
    const id = this.nextId
    this.nextId += 1
    return id
  }

  isOpen() {
    return this.state === 'open'
  }

  connect() {
    if (this.connecting) return this.connecting
    if (this.state === 'open') return Promise.resolve(this)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.manualClose = false
    this._setState('connecting')

    const promise = auth.ensureToken(this.endpoint).then((token) => new Promise((resolve, reject) => {
      // close() may have run while ensureToken() was in flight; never open a
      // socket after the owner has explicitly torn the page down.
      if (this.manualClose) {
        reject(util.makeError('WS_CLOSED', '连接已关闭'))
        return
      }
      const url = store.wsUrl(this.endpoint.baseUrl, '/api/ws') + '?token=' + encodeURIComponent(token)
      let settled = false
      const task = wx.connectSocket({ url: url, timeout: 20000 })
      this.task = task

      task.onOpen(() => {
        if (this.task !== task || this.manualClose) return
        this._setState('open')
        this._startPing()
        this._send({ jsonrpc: '2.0', id: this._id(), method: 'client.capabilities', params: { server_requests: true } })
        this.reconnectAttempt = 0
        if (!settled) {
          settled = true
          resolve(this)
        }
        this._emit('onOpen')
      })

      task.onMessage((ev) => {
        if (this.task !== task) return
        this._onMessage(ev.data)
      })

      task.onError((err) => {
        if (this.task !== task) return
        this._emit('onError', err)
        if (!settled) {
          settled = true
          reject(util.makeError('WS_ERROR', (err && err.errMsg) || 'WebSocket 连接失败'))
        }
      })

      task.onClose((ev) => {
        // A newer socket may already be active; never tear its state down from
        // the close callback of an older task, but still settle the old promise.
        if (this.task && this.task !== task) {
          if (!settled) {
            settled = true
            reject(util.makeError('WS_CLOSED', 'WebSocket 连接被关闭'))
          }
          return
        }
        this.task = null
        this._stopPing()
        this._setState('closed')
        // Pending RPCs must fail immediately on a dropped socket; otherwise the
        // UI waits for the full RPC timeout (up to 90s) while the gateway is
        // already reconnecting.
        this._failPending('WS_CLOSED', '连接已断开')
        this.openRequests = {}
        if (!settled) {
          settled = true
          const code = ev && ev.code
          reject(util.makeError('WS_CLOSED', 'WebSocket 连接被关闭' + (code ? '（' + code + '）' : '')))
        }
        this._emit('onClose', ev)
        if (!this.manualClose) this._scheduleReconnect(ev)
      })
    }))

    this.connecting = promise
    const clear = () => { this.connecting = null }
    promise.then(clear, clear)
    return promise
  }

  _scheduleReconnect(ev) {
    if (this.manualClose || this.reconnectTimer) return
    const code = ev && ev.code
    const attempt = this.reconnectAttempt
    this.reconnectAttempt = Math.min(attempt + 1, 6)
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * Math.pow(2, attempt))
    this._setState('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.manualClose) return
      const retry = code === 4401
        ? auth.refresh(this.endpoint).then(
          () => (this.manualClose ? Promise.reject(util.makeError('WS_CLOSED', '连接已关闭')) : this.connect()),
          () => Promise.reject(util.makeError('AUTH_REFRESH', '登录刷新失败'))
        )
        : this.connect()
      retry.then(
        () => this._emit('onReopen'),
        () => {
          if (!this.manualClose) this._scheduleReconnect({})
        }
      )
    }, delay)
  }

  _startPing() {
    this._stopPing()
    this.pingTimer = setInterval(() => {
      this._send({ jsonrpc: '2.0', id: this._id(), method: 'ping', params: {} })
    }, PING_INTERVAL_MS)
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  _send(frame, onFail) {
    if (this.state !== 'open' || !this.task) return false
    try {
      this.task.send({
        data: JSON.stringify(frame),
        fail: (err) => {
          if (typeof onFail === 'function') onFail(err)
        }
      })
      return true
    } catch (e) {
      return false
    }
  }

  _onMessage(data) {
    let frame
    try {
      frame = JSON.parse(data)
    } catch (e) {
      return
    }
    if (!frame || typeof frame !== 'object') return

    if (frame.method === 'event') {
      const params = frame.params || {}
      const type = params.type || ''
      const payload = params.payload || {}
      if (type === 'request.cancel') {
        const cancelled = payload.id || payload.request_id
        if (cancelled) delete this.openRequests[cancelled]
        this._emit('onRequestCancel', payload)
      }
      // session.steer 需要当前执行代次。不同版本的 Hermes 会把它放在
      // params 外层、payload 或 stamp 子对象里，这里统一取一次。
      const nested = params.stamp && typeof params.stamp === 'object' ? params.stamp : {}
      const stamp = {
        execution_generation: firstDefined([
          params.execution_generation,
          payload.execution_generation,
          nested.execution_generation,
          frame.execution_generation
        ]),
        authority_epoch: firstDefined([
          params.authority_epoch,
          payload.authority_epoch,
          nested.authority_epoch,
          frame.authority_epoch
        ]),
        admission_id: firstDefined([
          params.admission_id,
          payload.admission_id,
          nested.admission_id,
          frame.admission_id
        ])
      }
      this._emit('onEvent', type, payload, params.session_id || '', stamp)
      return
    }

    if (typeof frame.id === 'string') {
      if (frame.method) {
        this.openRequests[frame.id] = frame
        this._emit('onServerRequest', frame)
      }
      return
    }

    if (frame.id !== undefined && frame.id !== null) {
      const entry = this.pending[frame.id]
      if (!entry) return
      delete this.pending[frame.id]
      clearTimeout(entry.timer)
      if (frame.error) {
        entry.reject(util.makeError('RPC', frame.error.message || 'RPC 调用失败', { rpcCode: frame.error.code }))
      } else {
        entry.resolve(frame.result)
      }
    }
  }

  rpc(method, params, timeout) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'open') {
        reject(util.makeError('WS_NOT_OPEN', '连接尚未就绪'))
        return
      }
      const id = this._id()
      const timer = setTimeout(() => {
        delete this.pending[id]
        reject(util.makeError('TIMEOUT', method + ' 超时'))
      }, timeout || 30000)
      this.pending[id] = { resolve, reject, timer }
      const sent = this._send({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, (err) => {
        const entry = this.pending[id]
        if (!entry) return
        delete this.pending[id]
        clearTimeout(entry.timer)
        entry.reject(util.makeError('WS_SEND', (err && err.errMsg) || '消息发送失败'))
      })
      if (!sent) {
        delete this.pending[id]
        clearTimeout(timer)
        reject(util.makeError('WS_NOT_OPEN', '连接尚未就绪'))
      }
    })
  }

  respond(id, result) {
    const sent = this._send({
      jsonrpc: '2.0',
      id: id,
      result: result === undefined ? {} : result
    })
    if (sent) delete this.openRequests[id]
    return sent
  }

  respondError(id, code, message) {
    const sent = this._send({
      jsonrpc: '2.0',
      id: id,
      error: { code: code, message: message }
    })
    if (sent) delete this.openRequests[id]
    return sent
  }

  close() {
    this.manualClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this._stopPing()
    this._failPending('WS_CLOSED', '连接已关闭')
    this.openRequests = {}
    const task = this.task
    this.task = null
    if (task) {
      try { task.close({ code: 1000 }) } catch (e) { /* ignore */ }
    }
    this._setState('closed')
  }
}

module.exports = Gateway
