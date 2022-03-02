const Protomux = require('protomux')
const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const m = require('./messages')

module.exports = class HypercoreProtocol {
  constructor (mux, opts) {
    this.muxer = Protomux.from(mux)
    this.stream = this.muxer.stream

    this.ondiscoverykey = (opts && opts.ondiscoverykey) || noop
    this.closed = false

    this._byDiscoveryKey = new Map()
    this._byId = []
    this._byRemoteId = []
    this._opens = []

    this.protocol = this.muxer.addProtocol({
      context: this,
      name: 'hypercore',
      messages: 13,
      onremoteclose: () => {
        this.closed = true

        const peers = this._byId

        this._byId = []
        this._byRemoteId = []
        this._byDiscoveryKey.clear()

        while (this._opens.length) {
          this._opens.pop().done()
        }

        for (let i = 0; i < peers.length; i++) {
          const peer = peers[i]
          if (!peer) continue
          this._callPeerClose(peer)
        }
      }
    })

    this.open = this.protocol.addMessage({ type: 0, encoding: m.wire.open, onmessage: onopen })
    this.close = this.protocol.addMessage({ type: 1, encoding: m.wire.close, onmessage: onclose })
    this.sync = this.protocol.addMessage({ type: 2, encoding: m.wire.sync, onmessage: onsync })
    this.request = this.protocol.addMessage({ type: 3, encoding: m.wire.request, onmessage: onrequest })
    this.cancel = this.protocol.addMessage({ type: 4, encoding: m.wire.cancel, onmessage: oncancel })
    this.data = this.protocol.addMessage({ type: 5, encoding: m.wire.data, onmessage: ondata })
    this.noData = this.protocol.addMessage({ type: 6, encoding: m.wire.noData, onmessage: onnodata })
    this.want = this.protocol.addMessage({ type: 7, encoding: m.wire.want, onmessage: onwant })
    this.unwant = this.protocol.addMessage({ type: 8, encoding: m.wire.unwant, onmessage: onunwant })
    this.bitfield = this.protocol.addMessage({ type: 9, encoding: m.wire.bitfield, onmessage: onbitfield })
    this.range = this.protocol.addMessage({ type: 10, encoding: m.wire.range, onmessage: onrange })
    this.reorgHint = this.protocol.addMessage({ type: 11, encoding: m.wire.reorgHint, onmessage: onreorghint })
  }

  cork () {
    this.protocol.cork()
  }

  uncork () {
    this.protocol.uncork()
  }

  async _callPeerClose (peer) {
    try {
      await peer.onremoteclose()
    } catch (err) {
      safetyCatch(err)
    }
  }

  _sync (id) {
    return id < this._byRemoteId.length ? this._byRemoteId[id] : null
  }

  async _async (id) {
    for (const p of this._opens) {
      if (p.id === id) {
        await p.promise
        break
      }
    }
    return this.closed ? null : this._sync(id)
  }

  _alloc () {
    const id = this._byId.indexOf(null)
    return id === -1 ? this._byId.push(null) - 1 : id
  }

  _setRemoteId (id, peer) {
    // TODO: Some better abstraction for this that is safer, allow MAX backlog...
    while (id >= this._byRemoteId.length) this._byRemoteId.push(null)
    this._byRemoteId[id] = peer
  }

  _get (dk, upsert) {
    const k = dk.toString('hex')

    let map = this._byDiscoveryKey.get(k)
    if (map || !upsert) return map

    map = [0, 0]
    this._byDiscoveryKey.set(k, map)
    return map
  }

  getPeer (discoveryKey) {
    const map = this._get(discoveryKey, false)
    if (!map) return null
    return this._byId[map[0]]
  }

  hasPeer (discoveryKey) {
    return this.getPeer(discoveryKey) !== null
  }

  addPeer (discoveryKey, peer) {
    if (this.closed) throw new Error('Protocol is closed')

    const id = this._alloc()
    const map = this._get(discoveryKey, true)

    map[0] = id
    this._byId[id] = peer

    return id
  }
}

async function onopen (msg, protocol) {
  let map = protocol._get(msg.discoveryKey, false)

  // Allow the receiver a chance to open the core if they want to
  if (!map) {
    const p = {
      id: msg.id,
      discoveryKey: msg.discoveryKey,
      promise: null,
      done: null
    }

    p.promise = new Promise((resolve) => { p.done = resolve })

    protocol._opens.push(p)

    try {
      await protocol.ondiscoverykey(msg.discoveryKey)
    } finally {
      const i = protocol._opens.indexOf(p)
      if (i > -1) protocol._opens.splice(i, 1)
      p.done()
    }
  }

  if (protocol.closed) return

  map = protocol._get(msg.discoveryKey, false)

  // Receiver didn't open it, send close signal
  if (!map) {
    protocol.close.send({ discoveryKey: msg.discoveryKey })
    return
  }

  const peer = protocol._byId[map[0]]

  // Check if remote already mapped it
  if (map[1] < protocol._byRemoteId.length && peer === protocol._byRemoteId[map[1]]) {
    throw new Error('Duplicate open')
  }

  // TODO: ... techically this should be async but, eh, too much work so sync for now
  // could be done by pipelining the entire onopen func tho prob
  peer.onremoteopen(msg)

  protocol._setRemoteId(msg.id, peer)
}

async function onclose (msg, protocol) {
  for (const p of protocol._opens) {
    if (b4a.equals(p.discoveryKey, msg.discoveryKey)) await p.promise
  }

  if (protocol.closed) return

  const map = protocol._get(msg.discoveryKey)
  if (!map) return

  const peer = protocol._byId[map[0]]

  // unref the peer
  protocol._byId[map[0]] = null
  if (map[1] < protocol._byRemoteId.length && protocol._byRemoteId[map[1]] === peer) {
    protocol._byRemoteId[map[1]] = null
  }
  protocol._byDiscoveryKey.delete(msg.discoveryKey.toString('hex'))

  return peer.onremoteclose()
}

async function onsync (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onsync(msg)
}

async function onrequest (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onrequest(msg)
}

async function oncancel (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.oncancel(msg)
}

async function ondata (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.ondata(msg)
}

async function onnodata (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onnodata(msg)
}

async function onwant (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onwant(msg)
}

async function onunwant (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onunwant(msg)
}

async function onrange (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onrange(msg)
}

async function onbitfield (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onbitfield(msg)
}

async function onreorghint (msg, protocol) {
  const peer = protocol._opens.length > 0 ? await protocol._async(msg.core) : protocol._sync(msg.core)
  if (peer !== null) return peer.onreorghint(msg)
}

function noop () {}
