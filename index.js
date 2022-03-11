const { EventEmitter } = require('events')
const raf = require('random-access-file')
const isOptions = require('is-options')
const hypercoreCrypto = require('hypercore-crypto')
const c = require('compact-encoding')
const b4a = require('b4a')
const Xache = require('xache')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const Protomux = require('protomux')
const codecs = require('codecs')

const fsctl = requireMaybe('fsctl') || { lock: noop, sparse: noop }

const Replicator = require('./lib/replicator')
const Core = require('./lib/core')
const BlockEncryption = require('./lib/block-encryption')
const { ReadStream, WriteStream } = require('./lib/streams')

const promises = Symbol.for('hypercore.promises')
const inspect = Symbol.for('nodejs.util.inspect.custom')

module.exports = class Hypercore extends EventEmitter {
  constructor (storage, key, opts) {
    super()

    if (isOptions(storage)) {
      opts = storage
      storage = null
      key = null
    } else if (isOptions(key)) {
      opts = key
      key = null
    }

    if (key && typeof key === 'string') {
      key = b4a.from(key, 'hex')
    }

    if (!opts) opts = {}

    if (!opts.crypto && key && key.byteLength !== 32) {
      throw new Error('Hypercore key should be 32 bytes')
    }

    if (!storage) storage = opts.storage

    this[promises] = true

    this.storage = null
    this.crypto = opts.crypto || hypercoreCrypto
    this.core = null
    this.replicator = null
    this.encryption = null
    this.extensions = opts.extensions || new Map()
    this.cache = opts.cache === true ? new Xache({ maxSize: 65536, maxAge: 0 }) : (opts.cache || null)

    this.valueEncoding = null
    this.encodeBatch = null
    this.activeRequests = []

    this.key = key || null
    this.keyPair = null
    this.readable = true
    this.writable = false
    this.opened = false
    this.closed = false
    this.sessions = opts._sessions || [this]
    this.sign = opts.sign || null
    this.autoClose = !!opts.autoClose

    this.closing = null
    this.opening = this._openSession(key, storage, opts)
    this.opening.catch(noop)

    this._preappend = preappend.bind(this)
    this._snapshot = opts.snapshot || null
  }

  [inspect] (depth, opts) {
    let indent = ''
    if (typeof opts.indentationLvl === 'number') {
      while (indent.length < opts.indentationLvl) indent += ' '
    }

    return this.constructor.name + '(\n' +
      indent + '  key: ' + opts.stylize((toHex(this.key)), 'string') + '\n' +
      indent + '  discoveryKey: ' + opts.stylize(toHex(this.discoveryKey), 'string') + '\n' +
      indent + '  opened: ' + opts.stylize(this.opened, 'boolean') + '\n' +
      indent + '  writable: ' + opts.stylize(this.writable, 'boolean') + '\n' +
      indent + '  sessions: ' + opts.stylize(this.sessions.length, 'number') + '\n' +
      indent + '  peers: [ ' + opts.stylize(this.peers.length, 'number') + ' ]\n' +
      indent + '  length: ' + opts.stylize(this.length, 'number') + '\n' +
      indent + '  byteLength: ' + opts.stylize(this.byteLength, 'number') + '\n' +
      indent + ')'
  }

  static protomux (stream, opts) {
    return stream.noiseStream.userData.open(opts)
  }

  static createProtocolStream (isInitiator, opts = {}) {
    let outerStream = isMuxer(isInitiator)
      ? isInitiator.stream
      : isStream(isInitiator)
        ? isInitiator
        : opts.stream

    let noiseStream = null

    if (outerStream) {
      noiseStream = outerStream.noiseStream
    } else {
      noiseStream = new NoiseSecretStream(isInitiator, null, opts)
      outerStream = noiseStream.rawStream
    }
    if (!noiseStream) throw new Error('Invalid stream')

    if (!noiseStream.userData) {
      const protocol = new Protomux(noiseStream)

      if (opts.ondiscoverykey) {
        protocol.pair({ protocol: 'hypercore/alpha' }, opts.ondiscoverykey)
      }
      if (opts.keepAlive !== false) {
        noiseStream.setKeepAlive(5000)
        noiseStream.setTimeout(7000)
      }
      noiseStream.userData = protocol
      noiseStream.on('error', noop) // All noise errors already propagate through outerStream
    }

    return outerStream
  }

  static defaultStorage (storage, opts = {}) {
    if (typeof storage !== 'string') return storage
    const directory = storage
    const toLock = opts.lock || 'oplog'
    return function createFile (name) {
      const locked = name === toLock || name.endsWith('/' + toLock)
      const lock = locked ? fsctl.lock : null
      const sparse = locked ? null : null // fsctl.sparse, disable sparse on windows - seems to fail for some people. TODO: investigate
      return raf(name, { directory, lock, sparse })
    }
  }

  snapshot () {
    return this.session({ snapshot: { length: this.length, byteLength: this.byteLength, fork: this.fork } })
  }

  session (opts = {}) {
    if (this.closing) {
      // This makes the closing logic alot easier. If this turns out to be a problem
      // in practive, open an issue and we'll try to make a solution for it.
      throw new Error('Cannot make sessions on a closing core')
    }

    const Clz = opts.class || Hypercore
    const s = new Clz(this.storage, this.key, {
      ...opts,
      extensions: this.extensions,
      _opening: this.opening,
      _sessions: this.sessions
    })

    s._passCapabilities(this)
    this.sessions.push(s)

    return s
  }

  _passCapabilities (o) {
    if (!this.sign) this.sign = o.sign
    this.crypto = o.crypto
    this.key = o.key
    this.core = o.core
    this.replicator = o.replicator
    this.encryption = o.encryption
    this.writable = !!this.sign
    this.autoClose = o.autoClose
  }

  async _openFromExisting (from, opts) {
    await from.opening

    for (const [name, ext] of this.extensions) {
      from.extensions.register(name, null, ext)
    }

    this._passCapabilities(from)
    this.extensions = from.extensions
    this.sessions = from.sessions
    this.storage = from.storage

    this.sessions.push(this)
  }

  async _openSession (key, storage, opts) {
    const isFirst = !opts._opening

    if (!isFirst) await opts._opening
    if (opts.preload) opts = { ...opts, ...(await opts.preload()) }

    const keyPair = (key && opts.keyPair)
      ? { ...opts.keyPair, publicKey: key }
      : key
        ? { publicKey: key, secretKey: null }
        : opts.keyPair

    // This only works if the hypercore was fully loaded,
    // but we only do this to validate the keypair to help catch bugs so yolo
    if (this.key && keyPair) keyPair.publicKey = this.key

    if (opts.sign) {
      this.sign = opts.sign
    } else if (keyPair && keyPair.secretKey) {
      this.sign = Core.createSigner(this.crypto, keyPair)
    }

    if (isFirst) {
      await this._openCapabilities(keyPair, storage, opts)
      // Only the root session should pass capabilities to other sessions.
      for (let i = 0; i < this.sessions.length; i++) {
        const s = this.sessions[i]
        if (s !== this) s._passCapabilities(this)
      }
    }

    if (!this.sign) this.sign = this.core.defaultSign
    this.writable = !!this.sign

    if (opts.valueEncoding) {
      this.valueEncoding = c.from(codecs(opts.valueEncoding))
    }
    if (opts.encodeBatch) {
      this.encodeBatch = opts.encodeBatch
    }

    // This is a hidden option that's only used by Corestore.
    // It's required so that corestore can load a name from userData before 'ready' is emitted.
    if (opts._preready) await opts._preready(this)

    this.opened = true
    this.emit('ready')
  }

  async _openCapabilities (keyPair, storage, opts) {
    if (opts.from) return this._openFromExisting(opts.from, opts)

    this.storage = Hypercore.defaultStorage(opts.storage || storage)

    this.core = await Core.open(this.storage, {
      createIfMissing: opts.createIfMissing,
      overwrite: opts.overwrite,
      keyPair,
      crypto: this.crypto,
      onupdate: this._oncoreupdate.bind(this)
    })

    if (opts.userData) {
      for (const [key, value] of Object.entries(opts.userData)) {
        await this.core.userData(key, value)
      }
    }

    this.key = this.core.header.signer.publicKey
    this.keyPair = this.core.header.signer

    this.replicator = new Replicator(this.core, this.key, {
      eagerUpdate: true,
      allowFork: true,
      onpeerupdate: this._onpeerupdate.bind(this),
      onupload: this._onupload.bind(this)
    })

    if (!this.encryption && opts.encryptionKey) {
      this.encryption = new BlockEncryption(opts.encryptionKey, this.key)
    }
  }

  close () {
    if (this.closing) return this.closing
    this.closing = this._close()
    return this.closing
  }

  async _close () {
    await this.opening

    const i = this.sessions.indexOf(this)
    if (i === -1) return

    this.sessions.splice(i, 1)
    this.readable = false
    this.writable = false
    this.closed = true

    const gc = []
    for (const ext of this.extensions.values()) {
      if (ext.session === this) gc.push(ext)
    }
    for (const ext of gc) ext.destroy()

    if (this.replicator !== null) {
      this.replicator.clearRequests(this.activeRequests)
    }

    if (this.sessions.length) {
      // if this is the last session and we are auto closing, trigger that first to enforce error handling
      if (this.sessions.length === 1 && this.autoClose) await this.sessions[0].close()
      // emit "fake" close as this is a session
      this.emit('close', false)
      return
    }

    await this.core.close()

    this.emit('close', true)
  }

  replicate (isInitiator, opts = {}) {
    const protocolStream = Hypercore.createProtocolStream(isInitiator, opts)
    const noiseStream = protocolStream.noiseStream
    const protocol = noiseStream.userData

    if (this.opened) {
      this.replicator.attachTo(protocol)
    } else {
      this.opening.then(() => this.replicator.attachTo(protocol), protocol.destroy.bind(protocol))
    }

    return protocolStream
  }

  get discoveryKey () {
    return this.replicator === null ? null : this.replicator.discoveryKey
  }

  get length () {
    return this._snapshot
      ? this._snapshot.length
      : (this.core === null ? 0 : this.core.tree.length)
  }

  get byteLength () {
    return this._snapshot
      ? this._snapshot.byteLength
      : (this.core === null ? 0 : this.core.tree.byteLength - (this.core.tree.length * this.padding))
  }

  get fork () {
    return this._snapshot
      ? this._snapshot.fork
      : (this.core === null ? 0 : this.core.tree.fork)
  }

  get peers () {
    return this.replicator === null ? [] : this.replicator.peers
  }

  get encryptionKey () {
    return this.encryption && this.encryption.key
  }

  get padding () {
    return this.encryption === null ? 0 : this.encryption.padding
  }

  ready () {
    return this.opening
  }

  _onupload (index, value, from) {
    const byteLength = value.byteLength - this.padding

    for (let i = 0; i < this.sessions.length; i++) {
      this.sessions[i].emit('upload', index, byteLength, from)
    }
  }

  _oncoreupdate (status, bitfield, value, from) {
    if (status !== 0) {
      for (let i = 0; i < this.sessions.length; i++) {
        if ((status & 0b10) !== 0) {
          if (this.cache) this.cache.clear()
          this.sessions[i].emit('truncate', bitfield.start, this.core.tree.fork)
        }
        if ((status & 0b01) !== 0) {
          this.sessions[i].emit('append')
        }
      }

      this.replicator.signalUpgrade()
    }

    if (bitfield) {
      this.replicator.broadcastRange(bitfield.start, bitfield.length, bitfield.drop)
    }

    if (value) {
      const byteLength = value.byteLength - this.padding

      for (let i = 0; i < this.sessions.length; i++) {
        this.sessions[i].emit('download', bitfield.start, byteLength, from)
      }
    }
  }

  _onpeerupdate (added, peer) {
  // if (added) this.extensions.update(peer)
    const name = added ? 'peer-add' : 'peer-remove'

    if (added) {
      for (const ext of this.extensions.values()) {
        peer.extensions.set(ext.name, ext)
      }
    }

    for (let i = 0; i < this.sessions.length; i++) {
      this.sessions[i].emit(name, peer)
    }
  }

  async setUserData (key, value) {
    if (this.opened === false) await this.opening
    return this.core.userData(key, value)
  }

  async getUserData (key) {
    if (this.opened === false) await this.opening
    for (const { key: savedKey, value } of this.core.header.userData) {
      if (key === savedKey) return value
    }
    return null
  }

  async update (opts) {
    if (this.opened === false) await this.opening

    // TODO: add an option where a writer can bootstrap it's state from the network also
    if (this.writable || this.closing !== null) return false

    const activeRequests = (opts && opts.activeRequests) || this.activeRequests
    const req = this.replicator.addUpgrade(activeRequests)

    return req.promise
  }

  async seek (bytes, opts) {
    if (this.opened === false) await this.opening

    const s = this.core.tree.seek(bytes, this.padding)

    const offset = await s.update()
    if (offset) return offset

    if (this.closing !== null) throw new Error('Session is closed')

    const activeRequests = (opts && opts.activeRequests) || this.activeRequests
    const req = this.replicator.addSeek(activeRequests, s)

    return req.promise
  }

  async has (index) {
    if (this.opened === false) await this.opening

    return this.core.bitfield.get(index)
  }

  async get (index, opts) {
    if (this.opened === false) await this.opening
    if (this.closing !== null) throw new Error('Session is closed')

    const c = this.cache && this.cache.get(index)
    if (c) return c
    const fork = this.core.tree.fork
    const b = await this._get(index, opts)
    if (this.cache && fork === this.core.tree.fork && b) this.cache.set(index, b)
    return b
  }

  async _get (index, opts) {
    const encoding = (opts && opts.valueEncoding && c.from(codecs(opts.valueEncoding))) || this.valueEncoding

    let block

    if (this.core.bitfield.get(index)) {
      block = await this.core.blocks.get(index)
    } else {
      if (opts && opts.wait === false) return null
      if (opts && opts.onwait) opts.onwait(index)

      const activeRequests = (opts && opts.activeRequests) || this.activeRequests
      const req = this.replicator.addBlock(activeRequests, index)

      block = await req.promise
    }

    if (this.encryption) this.encryption.decrypt(index, block)
    return this._decode(encoding, block)
  }

  createReadStream (opts) {
    return new ReadStream(this, opts)
  }

  createWriteStream (opts) {
    return new WriteStream(this, opts)
  }

  download (range) {
    const reqP = this._download(range)

    // do not crash in the background...
    reqP.catch(noop)

    // TODO: turn this into an actual object...
    return {
      async downloaded () {
        const req = await reqP
        return req.promise
      },
      destroy () {
        reqP.then(req => req.context.detach(req), noop)
      }
    }
  }

  async _download (range) {
    if (this.opened === false) await this.opening
    const activeRequests = (range && range.activeRequests) || this.activeRequests
    return this.replicator.addRange(activeRequests, range)
  }

  // TODO: get rid of this / deprecate it?
  undownload (range) {
    range.destroy(null)
  }

  // TODO: get rid of this / deprecate it?
  cancel (request) {
    // Do nothing for now
  }

  async truncate (newLength = 0, fork = -1) {
    if (this.opened === false) await this.opening
    if (this.writable === false) throw new Error('Core is not writable')

    if (fork === -1) fork = this.core.tree.fork + 1
    await this.core.truncate(newLength, fork, this.sign)

    // TODO: Should propagate from an event triggered by the oplog
    this.replicator.updateAll()
  }

  async append (blocks) {
    if (this.opened === false) await this.opening
    if (this.writable === false) throw new Error('Core is not writable')

    blocks = Array.isArray(blocks) ? blocks : [blocks]

    const preappend = this.encryption && this._preappend

    const buffers = this.encodeBatch !== null ? this.encodeBatch(blocks) : new Array(blocks.length)

    if (this.encodeBatch === null) {
      for (let i = 0; i < blocks.length; i++) {
        buffers[i] = this._encode(this.valueEncoding, blocks[i])
      }
    }

    return await this.core.append(buffers, this.sign, { preappend })
  }

  async treeHash (length) {
    if (length === undefined) {
      await this.ready()
      length = this.core.length
    }

    const roots = await this.core.tree.getRoots(length)
    return this.crypto.tree(roots)
  }

  registerExtension (name, handlers = {}) {
    if (this.extensions.has(name)) {
      const ext = this.extensions.get(name)
      ext.handlers = handlers
      ext.encoding = c.from(codecs(handlers.encoding) || c.buffer)
      ext.session = this
      return ext
    }

    const ext = {
      name,
      handlers,
      encoding: c.from(codecs(handlers.encoding) || c.buffer),
      session: this,
      send (message, peer) {
        const buffer = c.encode(this.encoding, message)
        peer.extension(name, buffer)
      },
      broadcast (message) {
        const buffer = c.encode(this.encoding, message)
        for (const peer of this.session.peers) {
          peer.extension(name, buffer)
        }
      },
      destroy () {
        for (const peer of this.session.peers) {
          peer.extensions.delete(name)
        }
        this.session.extensions.delete(name)
      },
      _onmessage (state, peer) {
        const m = this.encoding.decode(state)
        if (this.handlers.onmessage) this.handlers.onmessage(m, peer)
      }
    }

    this.extensions.set(name, ext)
    for (const peer of this.peers) {
      peer.extensions.set(name, ext)
    }

    return ext
  }

  _encode (enc, val) {
    const state = { start: this.padding, end: this.padding, buffer: null }

    if (b4a.isBuffer(val)) {
      if (state.start === 0) return val
      state.end += val.byteLength
    } else if (enc) {
      enc.preencode(state, val)
    } else {
      val = b4a.from(val)
      if (state.start === 0) return val
      state.end += val.byteLength
    }

    state.buffer = b4a.allocUnsafe(state.end)

    if (enc) enc.encode(state, val)
    else state.buffer.set(val, state.start)

    return state.buffer
  }

  _decode (enc, block) {
    block = block.subarray(this.padding)
    if (enc) return c.decode(enc, block)
    return block
  }
}

function noop () {}

function isStream (s) {
  return typeof s === 'object' && s && typeof s.pipe === 'function'
}

function isMuxer (m) {
  return typeof m === 'object' && m && m.isProtomux === true
}

function requireMaybe (name) {
  try {
    return require(name)
  } catch (_) {
    return null
  }
}

function toHex (buf) {
  return buf && b4a.toString(buf, 'hex')
}

function preappend (blocks) {
  const offset = this.core.tree.length
  const fork = this.core.tree.fork

  for (let i = 0; i < blocks.length; i++) {
    this.encryption.encrypt(offset + i, blocks[i], fork)
  }
}
