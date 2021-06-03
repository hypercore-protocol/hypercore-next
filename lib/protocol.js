const { EventEmitter } = require('events')
const { uint, from: fromEncoding } = require('compact-encoding')
const codecs = require('codecs')

const messages = require('./messages')

class Extension {
  constructor (protocol, type, name, handlers) {
    this.protocol = protocol
    this.name = name
    this.type = type
    this.peers = new Set()
    this.aliased = !!handlers.aliased
    this.remoteSupports = false
    this.onmessage = handlers.onmessage || noop
    this.onremotesupports = handlers.onremotesupports || noop
    this.encoding = fromEncoding(codecs(handlers.encoding || 'binary'))
    this.announce()
  }

  announce () {
    this.protocol.send(1, messages.extension, -1, { alias: this.type, name: this.name })
  }

  send (message) {
    return this._sendAlias(message, -1)
  }

  _sendAlias (message, alias) {
    if (this._remoteAliases) {
      return this.protocol.send(this.type, this.encoding, alias, message)
    }

    this.protocol.cork()
    this.announce()
    this.protocol.send(this.type, this.encoding, alias, message)
    this.protocol.uncork()

    return false
  }

  _onremotesupports () {
    this.remoteSupports = true
    this.onremotesupports(this)
    for (const peer of this.peers) {
      peer.onremotesupports(peer)
    }
  }

  _onmessage (state) {
    if (!this.aliased) {
      this.onmessage(this.encoding.decode(state))
      return
    }

    const alias = uint.decode(state)
    const m = this.encoding.decode(state)

    for (const peer of this.peers) {
      if (peer.alias === alias) {
        peer.onmessage(m, peer)
      }
    }
  }
}

class CoreExtension {
  constructor (ext, peer, name, handlers) {
    this.extension = ext
    this.peer = peer
    this.name = name
    this.alias = peer.alias
    this.onmessage = handlers.onmessage || noop
    this.onremotesupports = handlers.onremotesupports || noop
  }

  get remoteSupports () {
    return this.extension.remoteSupports
  }

  announce () {
    this.extension.announce()
  }

  send (message) {
    return this.extension._sendAlias(message, this.peer.alias)
  }

  destroy () {
    this.peer.extensions.delete(this.name)
    this.extension.peers.delete(this)
  }
}

class CoreHandler {
  constructor (protocol, alias, key, discoveryKey, handlers, state) {
    this.protocol = protocol
    this.handlers = handlers
    this.key = key
    this.discoveryKey = discoveryKey
    this.alias = alias
    this.remoteAlias = -1
    this.resend = false
    this.state = state
    this.extensions = new Map()

    this._destroyer = this.destroy.bind(this)
  }

  onmessage (type, state) {
    const handlers = this.handlers

    switch (type) {
      case 4: {
        if (handlers.oninfo) this._catch(handlers.oninfo(messages.info.decode(state), this))
        break
      }

      case 5: {
        // options
        break
      }

      case 6: {
        // want
        break
      }

      case 7: {
        if (handlers.onhave) this._catch(handlers.onhave(messages.have.decode(state), this))
        break
      }

      case 8: {
        if (handlers.onbitfield) this._catch(handlers.onbitfield(messages.bitfield.decode(state), this))
        break
      }

      case 9: {
        if (handlers.onrequest) this._catch(handlers.onrequest(messages.request.decode(state), this))
        break
      }

      case 10: {
        if (handlers.ondata) this._catch(handlers.ondata(messages.data.decode(state), this))
        break
      }
    }

    state.start = state.end
  }

  _catch (p) {
    if (isPromise(p)) p.then(noop, this._destroyer)
  }

  registerExtension (name, handlers) {
    if (this.extensions.has(name)) return this.extensions.get(name)
    const ext = this.protocol.registerExtension(name, { aliased: true, encoding: handlers.encoding })
    const coreExt = new CoreExtension(ext, this, name, handlers)
    ext.peers.add(coreExt)
    this.extensions.set(name, coreExt)
    return coreExt
  }

  cork () {
    this.protocol.cork()
  }

  uncork () {
    this.protocol.uncork()
  }

  info (message) {
    return this.protocol.send(4, messages.info, this.alias, message)
  }

  options (message) {
    // TODO
    // this._send(5, messages.info, this.alias, message)
  }

  want (message) {
    // TODO
    // this._send(6, messages.info, this.alias, message)
  }

  have (message) {
    return this.protocol.send(7, messages.have, this.alias, message)
  }

  bitfield (message) {
    return this.protocol.send(8, messages.bitfield, this.alias, message)
  }

  request (message) {
    return this.protocol.send(9, messages.request, this.alias, message)
  }

  data (message) {
    return this.protocol.send(10, messages.data, this.alias, message)
  }

  destroy (err) {
    return this.protocol.unregisterCoreHandler(err, this)
  }
}

module.exports = class Protocol extends EventEmitter {
  constructor (noiseStream, handlers = {}) {
    super()
    this.noiseStream = noiseStream

    this.protocolVersion = handlers.protocolVersion || 0
    this.userAgent = handlers.userAgent || ''
    this.remoteUserAgent = ''
    this.handlers = handlers

    this._firstMessage = true
    this._corks = 1
    this._batch = []

    this._localAliases = 0
    this._remoteAliases = []
    this._coreHandlers = new Map()

    this._localExtensions = 128
    this._remoteExtensions = []
    this._extensions = new Map()

    this._destroyer = this.destroy.bind(this)
    this.noiseStream.on('data', this.onmessage.bind(this))

    const m = { protocolVersion: this.protocolVersion, userAgent: this.userAgent }
    const state = { start: 0, end: 0, buffer: null }

    messages.handshake.preencode(state, m)
    state.buffer = this.noiseStream.alloc(state.end)
    messages.handshake.encode(state, m)
    this.noiseStream.write(state.buffer)
  }

  registerCoreHandler (key, discoveryKey, handlers = {}, state = null) {
    const coreHandler = new CoreHandler(this, this._localAliases++, key, discoveryKey, handlers, state)
    this._coreHandlers.set(discoveryKey.toString('hex'), coreHandler)
    this._announceCore(coreHandler.alias, key, discoveryKey)
    return coreHandler
  }

  unregisterCoreHandler (err, handler) {
    if (err) {
      this.noiseStream.destroy(err)
      return
    }

    this._coreHandlers.delete(handler.discoveryKey.toString('hex'))

    if (handler.remoteAlias > -1) {
      this._remoteAliases[handler.remoteAlias] = null
      handler.remoteAlias = -1
    }
  }

  registerExtension (name, handlers) {
    let ext = this._extensions.get(name)
    if (ext) return ext
    ext = new Extension(this, this._localExtensions++, name, handlers)
    this._extensions.set(name, ext)
    return ext
  }

  cork () {
    if (++this._corks === 1) this._batch = []
  }

  uncork () {
    if (--this._corks > 0) return

    const batch = this._batch
    this._batch = null

    if (batch.length === 0) return

    const state = { start: 0, end: 0, buffer: null }
    const lens = new Array(batch.length)

    uint.preencode(state, 0)
    for (let i = 0; i < batch.length; i++) {
      const [type, enc, dk, message] = batch[i]
      const start = state.end
      uint.preencode(state, type)
      if (dk > -1) uint.preencode(state, dk)
      enc.preencode(state, message)
      uint.preencode(state, (lens[i] = state.end - start))
    }

    state.buffer = this.noiseStream.alloc(state.end)

    uint.encode(state, 0)
    for (let i = 0; i < batch.length; i++) {
      const [type, enc, dk, message] = batch[i]
      uint.encode(state, lens[i])
      uint.encode(state, type)
      if (dk > -1) uint.encode(state, dk)
      enc.encode(state, message)
    }

    this.noiseStream.write(state.buffer)
  }

  onmessage (message) {
    try {
      this._decode(message)
    } catch (err) {
      this.destroy(err)
    }
  }

  _catch (p) {
    if (isPromise(p)) p.then(noop, this._destroyer)
  }

  _announceCore (alias, key, discoveryKey) {
    this.send(2, messages.core, -1, {
      alias: alias,
      discoveryKey: discoveryKey,
      capability: Buffer.alloc(32) // TODO
    })
  }

  _decode (buffer) {
    const state = { start: 0, end: buffer.length, buffer }

    if (this._firstMessage === true) {
      this._firstMessage = false
      const { userAgent } = messages.handshake.decode(state)
      this.remoteUserAgent = userAgent
      this.emit('handshake')
      this.uncork()
      return
    }

    const type = uint.decode(state)

    if (type === 0) { // batch
      while (state.start < state.end) {
        const len = uint.decode(state)
        state.end = state.start + len
        const type = uint.decode(state)
        this._decodeMessage(type, state)
        state.end = buffer.length
      }
    } else {
      this._decodeMessage(type, state)
    }
  }

  _decodeMessage (type, state) {
    switch (type) {
      case 1: return this._onextension(messages.extension.decode(state))
      case 2: return this._oncore(messages.core.decode(state))
      case 3: return this._onunknowncore(messages.unknownCore.decode(state))
    }

    if (type < 11) {
      const remoteAlias = uint.decode(state)
      const peer = this._remoteAliases[remoteAlias]
      if (peer) peer.onmessage(type, state)
      else state.start = state.end
      return
    }

    if (type >= 128) {
      const ext = this._remoteExtensions[type - 128]
      if (ext) ext._onmessage(state)
      else state.start = state.end
    }
  }

  _onextension (m) {
    const type = m.alias - 128
    const ext = this._extensions.get(m.name)

    if (!ext) return

    if (type === this._remoteExtensions.length) {
      this._remoteExtensions.push(null)
    }

    if (type < 0 || type >= this._remoteExtensions.length) {
      this.destroy(new Error('Remote alias out of bounds'))
      return
    }

    this._remoteExtensions[type] = ext
    if (!ext.remoteSupports) ext._onremotesupports()
  }

  _oncore (m) {
    const hex = m.discoveryKey.toString('hex')
    const peer = this._coreHandlers.get(hex)

    // allow one alloc
    // TODO: if the remote allocs too many "holes", move to slower sparse firendly
    // data structures such as a Map
    if (m.alias === this._remoteAliases.length) this._remoteAliases.push(null)

    if (peer) {
      // TODO: check cap

      if (m.alias >= this._remoteAliases.length) {
        this.destroy(new Error('Remote alias out of bounds'))
        return
      }

      this._remoteAliases[m.alias] = peer
      peer.remoteAlias = m.alias
      if (peer.resend) this._announceCore(peer.alias, peer.key, peer.discoveryKey)
      if (peer.handlers.oncore) this._catch(peer.handlers.oncore(m, peer))
      return
    }

    const self = this
    const p = this.handlers.ondiscoverykey ? this.handlers.ondiscoverykey(m.discoveryKey) : undefined

    if (isPromise(p)) p.then(next, next)
    else next()

    function next () {
      if (self._coreHandlers.has(hex)) return self._oncore(m)
      self.send(3, messages.unknownCore, -1, { discoveryKey: m.discoveryKey })
    }
  }

  _onunknowncore (m) {
    const peer = this._coreHandlers.get(m.discoveryKey.toString('hex'))
    if (!peer) return

    peer.resend = true
    if (peer.handlers.onunknowncore) this._catch(peer.handlers.onunknowncore(m, peer))
  }

  send (type, enc, dk, message) {
    if (this._corks > 0) {
      this._batch.push([type, enc, dk, message])
      return false
    }

    const state = { start: 0, end: 0, buffer: null }

    uint.preencode(state, type)
    if (dk > -1) uint.preencode(state, dk)
    enc.preencode(state, message)

    state.buffer = this.noiseStream.alloc(state.end)

    uint.encode(state, type)
    if (dk > -1) uint.encode(state, dk)
    enc.encode(state, message)

    return this.noiseStream.write(state.buffer)
  }

  destroy (err) {
    return this.noiseStream.destroy(err)
  }
}

function noop () {}

function isPromise (p) {
  return !!p && typeof p.then === 'function'
}
