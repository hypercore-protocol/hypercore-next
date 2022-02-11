const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const RandomIterator = require('random-array-iterator')
const RemoteBitfield = require('./remote-bitfield')

const DEFAULT_MAX_INFLIGHT = 32

class ListenerQueue {
  constructor () {
    this.promises = []
  }

  attach () {
    const inv = {
      promise: null,
      resolve: null,
      reject: null
    }

    inv.promise = new Promise((resolve, reject) => {
      inv.resolve = resolve
      inv.reject = reject
    })

    this.promises.push(inv)

    return inv
  }

  detach (inv) {
    const i = this.promises.indexOf(inv)
    if (i === -1) return
    if (i < this.promises.length - 1) this.promises[i] = this.promises.pop()
    else this.promises.pop()
  }

  resolve (value) {
    for (let i = 0; i < this.promises.length; i++) {
      this.promises[i].resolve(value)
    }
  }

  reject (err) {
    for (let i = 0; i < this.promises.length; i++) {
      this.promises[i].reject(err)
    }
  }
}

class InflightTracker {
  constructor () {
    this._requests = []
    this._free = []
  }

  * [Symbol.iterator] () {
    for (const req of this._requests) {
      if (req !== null) yield req
    }
  }

  add (req) {
    const id = this._free.length ? this._free.pop() : this._requests.push(null)

    req.id = id
    this._requests[id - 1] = req
    return req
  }

  get (id) {
    return id <= this._requests.length ? this._requests[id - 1] : null
  }

  remove (id) {
    if (id <= this._requests.length) {
      this._requests[id - 1] = null
      this._free.push(id)
    }
  }
}

class BlockTracker {
  constructor (core) {
    this._core = core
    this._fork = core.tree.fork

    this._indexed = new Map()
    this._additional = []
  }

  * [Symbol.iterator] () {
    yield * this._indexed.values()
    yield * this._additional
  }

  has (fork, index) {
    return this.get(fork, index) !== null
  }

  get (fork, index) {
    if (this._fork === fork) return this._indexed.get(index) || null
    for (const b of this._additional) {
      if (b.index === index && b.fork === fork) return b
    }
    return null
  }

  add (fork, index) {
    // TODO: just rely on someone calling .update(fork) instead
    if (this._fork !== this._core.tree.fork) this.update(this._core.tree.fork)

    let b = this.get(fork, index)
    if (b) return b

    b = {
      fork,
      index,
      inflight: [],
      queued: false,
      listeners: null
    }

    if (fork === this._fork) this._indexed.set(index, b)
    else this._additional.push(b)

    return b
  }

  remove (fork, index) {
    if (this._fork === fork) {
      const b = this._indexed.get(index)
      this._indexed.delete(index)
      return b || null
    }

    for (let i = 0; i < this._additional.length; i++) {
      const b = this._additional[i]
      if (b.index !== index || b.fork !== fork) continue
      if (i === this._additional.length - 1) this._additional.pop()
      else this._additional[i] = this._additional.pop()
      return b
    }

    return null
  }

  update (fork) {
    if (this._fork === fork) return

    const additional = this._additional
    if (this._additional.length > 0) this._additional = []

    for (const b of this._indexed.values()) this._additional.push(b)
    this._indexed.clear()

    for (const b of additional) {
      if (b.fork === fork) this._indexed.set(b.index, b)
      else this._additional.push(b)
    }

    this._fork = fork
  }
}

class Peer {
  constructor (replicator, protocol) {
    this.protocol = protocol
    this.core = replicator.core
    this.replicator = replicator
    this.stream = protocol.stream

    this.inflight = 0
    this.maxInflight = DEFAULT_MAX_INFLIGHT

    this.alias = 0
    this.upgradeableLength = 0

    // TODO: tweak pipelining so that data sent BEFORE remoteOpened is not cap verified!
    // we might wanna tweak that with some crypto, ie use the cap to encrypt it...
    // or just be aware of that, to only push non leaky data

    this.remoteOpened = false
    this.remoteBitfield = new RemoteBitfield()
    this.remoteSignaled = false
    this.remoteFork = 0
    this.remoteLength = 0
    this.remoteUpgradeableLength = 0
  }

  signalUpgrade () {
    this.protocol.upgrade.send({
      core: this.alias,
      fork: this.core.tree.fork,
      length: this.core.tree.length,
      upgradeableLength: this.upgradeableLength
    })
  }

  broadcastRange (start, length, drop) {
    this.protocol.range.send({
      core: this.alias,
      want: 0,
      drop,
      start,
      length
    })
  }

  onremoteopen ({ capability }) {
    this.remoteOpened = true

console.log('TODO:', this.replicator.name, 'peer open, cap=', capability)

    this.protocol.cork()

    this.signalUpgrade()

    const p = pages(this.core)

    for (let index = 0; index < p.length; index++) {
      this.protocol.bitfield.send({
        core: this.alias,
        want: 0,
        start: index * this.core.bitfield.pageSize,
        bitfield: p[index]
      })
    }

    this.replicator._addPeer(this)

    this.protocol.uncork()
  }

  onremoteclose () {
    if (!this.remoteOpened) return
    this.remoteOpened = false
    this.replicator._removePeer(this)
  }

  onupgrade ({ fork, length, upgradeableLength }) {
    this.remoteSignaled = true
    this.remoteFork = fork
    this.remoteLength = length
    this.remoteUpgradeableLength = upgradeableLength

    this.replicator._updateFork(this)

    if (this.remoteLength > this.core.tree.length && this.remoteUpgradeableLength === this.core.tree.length) {
      if (this.replicator._addUpgradeMaybe() !== null) this._update()
    }

    return this._updateUpgradeable()
  }

  // TODO: this needs to be called more often prob (ie "if the remote was NOT upgradeable but not is" scenarios)
  async _updateUpgradeable () {
    if (this.remoteFork !== this.core.tree.fork) return
    if (this.remoteLength >= this.core.tree.length || this.remoteLength === 0) return
    if (this.remoteLength === this.upgradeableLength) return

    const len = this.remoteLength
    const fork = this.core.tree.fork

    // Rely on caching to make sure this is cheap...
    if (!(await this.core.tree.upgradeable(len))) return

    // Re-check conditions as we were async...
    if (this.remoteLength !== len || this.remoteFork !== fork) return
    if (this.remoteLength === this.upgradeableLength) return

    this.upgradeableLength = len
    this.signalUpgrade()
  }

  async _getProof (msg) {
    const proof = await this.core.tree.proof(msg)

    if (proof.block) {
      if (msg.fork !== this.core.tree.fork) return null
      proof.block.value = await this.core.blocks.get(msg.block.index)
    }

    return proof
  }

  async onrequest (msg) {
    let proof = null
// console.log(this.replicator.name, 'onrequest', msg)
    // TODO: could still be answerable if (index, fork) is an ancestor of the current fork
    if (msg.fork === this.core.tree.fork) {
      try {
        proof = await this._getProof(msg)
      } catch (err) { // TODO: better error handling here, ie custom errors
        safetyCatch(err)
        console.log('err', err)
      }
    }

    if (proof !== null) {
      this.protocol.data.send({
        core: this.alias,
        request: msg.id,
        fork: msg.fork,
        block: proof.block,
        hash: proof.hash,
        seek: proof.seek,
        upgrade: proof.upgrade
      })
      return
    }

    this.protocol.noData.send({
      core: this.alias,
      request: msg.id
    })
  }

  async ondata (data) {
// console.log(this.replicator.name, 'ondata', data)

    const req = data.request > 0 ? this.replicator._inflight.get(data.request) : null
    const reorg = data.fork > this.core.tree.fork

    // no push atm, TODO: check if this satisfies another pending request
    // allow reorg pushes tho as those are not written to storage so we'll take all the help we can get
    if (req === null && reorg === false) return

    if (req !== null) {
      if (req.peer !== this) return
      this.replicator._inflight.remove(req.id)
    }

    if (reorg === true) return this.replicator._onreorgdata(this, req, data)

    try {
      if (!matchingRequest(req, data) || !(await this.core.verify(data, this))) {
        this.replicator._onnodata(this, req)
        return
      }
    } catch (err) {
      this.replicator._onnodata(this, req)
      throw err
    }

    this.replicator._ondata(this, req, data)
  }

  onnodata ({ request }) {
    const req = request > 0 ? this.replicator._inflight.get(request) : null

    if (req !== null || req.peer !== this) return

    this.replicator._inflight.remove(req.id)
    this.replicator._onnodata(this, req)
  }

  onrange ({ want, drop, start, length }) {
    const has = drop === false

// console.log(this.replicator.name, 'onrange', { drop, start, length })
    for (const end = start + length; start < end; start++) {
      this.remoteBitfield.set(start, has)
    }

    if (drop === false) this._update()
  }

  onbitfield ({ want, start, bitfield }) {
    // TODO: tweak this to be more generic
// console.log('onbitfield', this.replicator.name)

    if (bitfield.length < 1024) {
      const buf = b4a.from(bitfield.buffer, bitfield.byteOffset, bitfield.byteLength)
      const bigger = b4a.concat([buf, b4a.alloc(4096 - buf.length)])
      bitfield = new Uint32Array(bigger.buffer, bigger.byteOffset, 1024)
    }

    this.remoteBitfield.pages.set(start / this.core.bitfield.pageSize, bitfield)

    this._update()
  }

  _update () {
    // TODO: if this is in a batch or similar it would be better to defer it
    // we could do that with nextTick/microtick mb? (combined with a property on the protocol to signal read buffer mb)
    this.replicator.updatePeer(this)
  }

  _makeRequest (fork, needsUpgrade) {
    if (needsUpgrade === true && this.replicator._shouldUpgrade(this) === false) {
      return null
    }

    if (needsUpgrade === false && fork === this.core.tree.fork && this.replicator._autoUpgrade(this) === true) {
      needsUpgrade = true
    }

    return {
      peer: this,
      id: 0,
      fork,
      core: this.alias,
      block: null,
      hash: null,
      seek: null,
      upgrade: needsUpgrade === false
        ? null
        : { start: this.core.tree.length, length: this.remoteLength - this.core.tree.length }
    }
  }

  _canUpgrade (oldLen) {
    return oldLen < this.remoteLength && this.remoteUpgradeableLength === this.core.tree.length
  }

  _upgradeAvailable (u) {
    return u.fork === this.core.tree.fork && this._canUpgrade(u.length)
  }

  _requestUpgrade (u) {
    const req = this._makeRequest(u.fork, true)
    if (req === null) return false

    this._send(req)

    return true
  }

  _seekAvailable (s) {
    if (s.seeker.start >= this.core.tree.length) {
      return s.seeker.start < this.remoteLength && this.remoteUpgradeableLength === this.core.tree.length
    }

    for (let i = s.seeker.start; i < s.seeker.end; i++) {
      if (this.remoteBitfield.get(i)) return true
    }

    return false
  }

  _requestSeek (s) {
    if (s.seeker.start >= this.core.tree.length) {
      const req = this._makeRequest(s.fork, true)

      // We need an upgrade for the seek, if non can be provided, skip
      if (req === null) return false

      req.seek = { bytes: s.seeker.bytes }

      s.inflight.push(req)
      this._send(req)

      return true
    }

    const len = s.seeker.end - s.seeker.start
    const off = s.seeker.start + Math.floor(Math.random() * len)

    for (let i = 0; i < len; i++) {
      let index = off + i
      if (index > s.seeker.end) index -= len

      if (this.remoteBitfield.get(index) === false) continue
      if (this.core.bitfield.get(index) === true) continue

      // Check if this block is currently inflight - if so pick another
      const b = this.replicator._blocks.get(s.fork, index)
      if (b !== null && b.inflight.length > 0) continue

      // Block is not inflight, but we only want the hash, check if that is inflight
      const h = this.replicator._hashes.add(s.fork, index)
      if (h.inflight.length > 0) continue

      const req = this._makeRequest(s.fork, false)

      req.hash = { index: 2 * index, nodes: 0 }
      req.seek = { bytes: s.seeker.bytes }

      s.inflight.push(req)
      h.inflight.push(req)
      this._send(req)

      return true
    }

    return false
  }

  // mb turn this into a YES/NO/MAYBE enum, could simplify ifavail logic
  _blockAvailable (b) { // TODO: fork also
    return this.remoteBitfield.get(b.index)
  }

  _requestBlock (b) {
    if (this.remoteBitfield.get(b.index) === false) return false

    const req = this._makeRequest(b.fork, b.index >= this.core.tree.length)
    if (req === null) return false

    req.block = { index: b.index, nodes: 0 }

    b.inflight.push(this)
    this._send(req)

    return true
  }

  _requestRange (r) {
    const end = Math.min(r.end === -1 ? this.remoteLength : r.end, this.remoteLength)
    if (end < r.start) return false

    const len = end - r.start
    const off = r.start + (r.linear ? 0 : Math.floor(Math.random() * len))

    // TODO: we should weight this to request blocks < .length first
    // as they are "cheaper" and will trigger an auto upgrade if possible
    // If no blocks < .length is avaible then try the "needs upgrade" range

    for (let i = 0; i < len; i++) {
      let index = off + i
      if (index >= end) index -= len

      if (r.blocks !== null) index = r.blocks[index]

      if (this.remoteBitfield.get(index) === false) continue
      if (this.core.bitfield.get(index) === true) continue

      const b = this.replicator._blocks.add(r.fork, index)
      if (b.inflight.length > 0) continue

      const req = this._makeRequest(r.fork, index >= this.core.tree.length)

      // If the request cannot be satisfied, dealloc the block request if no one
      // is subscribed to it (mb we should make a helper for inflight === 0 && no listeners gc)
      if (req === null) {
        if (b.listeners === null) this.replicator._blocks.remove(b)
        return false
      }

      req.block = { index, nodes: 0 }

      b.inflight.push(req)
      this._send(req)

      return true
    }

    return false
  }

  _requestForkProof (f) {
    const req = this._makeRequest(f.fork, false)

    req.upgrade = { start: 0, length: this.remoteLength }

    f.inflight.push(req)
    this._send(req)
  }

  _requestForkRange (f) {
    if (f.fork !== this.remoteFork || f.batch.want === null) return false

    const end = Math.min(f.batch.want.end, this.remoteLength)
    if (end < f.batch.want.start) return false

    const len = end - f.batch.want.start
    const off = f.batch.want.start + Math.floor(Math.random() * len)

    for (let i = 0; i < len; i++) {
      let index = off + i
      if (index >= end) index -= len

      if (this.remoteBitfield.get(index) === false) continue

      const req = this._makeRequest(f.fork, false)

      req.hash = { index: 2 * index, nodes: f.batch.want.nodes }

      f.inflight.push(req)
      this._send(req)

      return true
    }

    return false
  }

  async _send (req) {
    const fork = this.core.tree.fork

    this.inflight++
    this.replicator._inflight.add(req)

    if (req.upgrade !== null && req.fork === fork) {
      const u = this.replicator._addUpgrade()
      u.inflight.push(req)
    }

    try {
      if (req.block !== null && req.fork === fork) req.block.nodes = await this.core.tree.missingNodes(2 * req.block.index)
      if (req.hash !== null && req.fork === fork) req.hash.nodes = await this.core.tree.missingNodes(req.hash.index)
    } catch (err) {
      this.protocol.stream.destroy(err)
      return
    }

    this.protocol.request.send(req)
  }
}

module.exports = class Replicator {
  constructor (core, key = core.key, discoveryKey = core.discoveryKey, eagerUpgrade = true) {
    this.key = key
    this.discoveryKey = discoveryKey
    this.core = core.core
    this.eagerUpgrade = eagerUpgrade
    this.allowFork = true
    this.peers = []

    this._inflight = new InflightTracker()
    this._blocks = new BlockTracker(core.core)
    this._hashes = new BlockTracker(core.core)

    this._queued = []

    this._seeks = []
    this._upgrade = null
    this._reorgs = []
    this._ranges = []

    this._updatesPending = 0
    this._applyingReorg = false
  }

  cork () {
    for (const peer of this.peers) peer.protocol.cork()
  }

  uncork () {
    for (const peer of this.peers) peer.protocol.uncork()
  }

  signalUpgrade () {
    for (const peer of this.peers) peer.signalUpgrade()
  }

  broadcastRange (start, length, drop = false) {
    for (const peer of this.peers) peer.broadcastRange(start, length, drop)
  }

  requestUpgrade () {
    if (this._upgrade) return this._upgrade.listeners.attach()

    this._addUpgrade()

    for (let i = this._reorgs.length - 1; i >= 0 && this._applyingReorg === false; i--) {
      const f = this._reorgs[i]
      if (f.batch !== null && f.batch.finished) {
        this._applyReorg(f)
        break
      }
    }

    this.updateAll()

    return this._upgrade.listeners.attach()
  }

  requestBlock (index, fork = this.core.tree.fork) {
    const b = this._blocks.add(fork, index)

    this._queueBlock(b)
    this.updateAll()

    if (b.listeners === null) b.listeners = new ListenerQueue()
    return b.listeners.attach()
  }

  requestSeek (seeker) {
    const s = {
      fork: this.core.tree.fork,
      seeker,
      inflight: [],
      listeners: new ListenerQueue()
    }

    this._seeks.push(s)
    this.updateAll()

    return s.listeners.attach()
  }

  addRange ({ start = 0, length = -1, blocks = null, linear = false }) {
    if (blocks !== null) {
      if (start >= blocks.length) start = blocks.length
      if (length === -1 || start + length > blocks.length) length = blocks.length - start
    }

    const r = {
      fork: this.core.tree.fork,
      linear,
      start,
      end: length === -1 ? -1 : start + length,
      blocks,
      listeners: new ListenerQueue()
    }

    this._ranges.push(r)

    // Trigger this to see if this is already resolved...
    // Also auto compresses the range based on local bitfield
    this._updateNonPrimary()

    return r.listeners.attach()
  }

  _addUpgradeMaybe () {
    return this.eagerUpgrade === true ? this._addUpgrade() : this._upgrade
  }

  _addUpgrade () {
    if (this._upgrade !== null) return this._upgrade

    // TODO: needs a reorg: true/false flag to indicate if the user requested a reorg
    this._upgrade = {
      fork: this.core.tree.fork,
      length: this.core.tree.length,
      inflight: [],
      listeners: new ListenerQueue()
    }

    return this._upgrade
  }

  _addReorg (fork, peer) {
    if (this.allowFork === false) return null

    // TODO: eager gc old reorgs from the same peer
    // not super important because they'll get gc'ed when the request finishes
    // but just spam the remote can do ...

    for (const f of this._reorgs) {
      if (f.fork > fork && f.batch !== null) return null
      if (f.fork === fork) return f
    }

    const f = {
      fork,
      inflight: [],
      batch: null
    }

    this._reorgs.push(f)

    // maintain sorted by fork
    let i = this._reorgs.length - 1
    while (i > 0 && this._reorgs[i - 1].fork > fork) {
      this._reorgs[i] = this._reorgs[i - 1]
      this._reorgs[--i] = f
    }

    return f
  }

  _shouldUpgrade (peer) {
    if (this._upgrade !== null && this._upgrade.inflight.length > 0) return false
    return peer.remoteUpgradeableLength === this.core.tree.length && peer.remoteLength > this.core.tree.length
  }

  _autoUpgrade (peer) {
    return this._upgrade !== null && this._shouldUpgrade(peer)
  }

  _addPeer (peer) {
    this.peers.push(peer)
    this.updatePeer(peer)
  }

  _removePeer (peer) {
    this.peers.splice(this.peers.indexOf(this), 1)

    for (const req of this._inflight) {
      if (req.peer !== peer) continue
      this._inflight.remove(req.id)
      this._onnodata(peer, req)
    }

    this.updateAll()
  }

  _queueBlock (b) {
    if (b.queued === true) return
    b.queued = true
    this._queued.push(b)
  }

  _resolveBlockRequest (tracker, fork, index, value, req) {
    const b = tracker.remove(fork, index)
    if (b === null) return false

    removeInflight(b.inflight, req)
    b.queued = false

    if (b.listeners !== null) b.listeners.resolve(value)

    return true
  }

  _resolveUpgradeRequest (req) {
    if (req !== null) removeInflight(this._upgrade.inflight, req)

    if (this.core.tree.length === this._upgrade.length && this.core.tree.fork === this._upgrade.fork) return false

    const u = this._upgrade
    this._upgrade = null
    u.listeners.resolve(true)

    return true
  }

  _clearInflightBlock (tracker, req) {
    const b = tracker.get(req.fork, req.block.index)

    if (b === null || removeInflight(b.inflight, req) === false) return

    if (b.listeners !== null && tracker === this._blocks) {
      this._queueBlock(b)
      return
    }

    if (b.inflight.length === 0) {
      tracker.remove(req.fork, req.block.index)
    }
  }

  _clearInflightUpgrade (req) {
    removeInflight(this._upgrade.inflight, req)
  }

  _clearInflightSeeks (req) {
    for (const s of this._seeks) {
      removeInflight(s.inflight, req)
    }
  }

  _clearInflightReorgs (req) {
    for (const r of this._reorgs) {
      removeInflight(r.inflight, req)
    }
  }

  _clearOldReorgs (fork) {
    for (let i = 0; i < this._reorgs.length; i++) {
      const f = this._reorgs[i]
      if (f.fork >= fork) continue
      if (i === this._reorgs.length - 1) this._reorgs.pop()
      else this._reorgs[i] = this._reorgs.pop()
      i--
    }
  }

  // "slow" updates here - async but not allowed to ever throw
  async _updateNonPrimary () {
    // Check if running, if so skip it and the running one will issue another update for us (debounce)
    while (++this._updatesPending === 1) {
      for (let i = 0; i < this._ranges.length; i++) {
        const r = this._ranges[i]

        while (r.start < r.end && this.core.bitfield.get(mapIndex(r.blocks, r.start)) === true) r.start++
        while (r.start < r.end && this.core.bitfield.get(mapIndex(r.blocks, r.end - 1)) === true) r.end--

        if (r.end === -1 || r.start < r.end) continue

        if (i < this._ranges.length - 1) this._ranges[i] = this._ranges.pop()
        else this._ranges.pop()

        i--

        r.listeners.resolve(true)
      }

      for (let i = 0; i < this._seeks.length; i++) {
        const s = this._seeks[i]

        let err = null
        let res = null

        try {
          res = await s.seeker.update()
        } catch (error) {
          err = error
        }

        if (!res && !err) continue

        if (i < this._seeks.length - 1) this._seeks[i] = this._seeks.pop()
        else this._seeks.pop()

        i--

        if (err) s.listeners.reject(err)
        else s.listeners.resolve(res)
      }

      this.updateAll()

      // No additional updates scheduled - return
      if (--this._updatesPending === 0) return
      // Debounce the additional updates - continue
      this._updatesPending = 0
    }
  }

  _onnodata (peer, req) {
    if (req.block !== null) {
      this._clearInflightBlock(this._blocks, req)
    }

    if (req.hash !== null) {
      this._clearInflightBlock(this._hashes, req)
    }

    if (req.upgrade !== null && this._upgrade !== null) {
      this._clearInflightUpgrade(req)
    }

    if (this._seeks.length > 0) {
      this._clearInflightSeeks(req)
    }

    if (this._reorgs.length > 0) {
      this._clearInflightReorgs(req)
    }

    this.updateAll()
  }

  _ondata (peer, req, data) {
    if (data.block !== null) {
      this._resolveBlockRequest(this._blocks, data.fork, data.block.index, data.block.value, req)
    }

    if (data.hash !== null && (data.hash.index & 1) === 0) {
      this._resolveBlockRequest(this._hashes, data.fork, data.hash.index / 2, null, req)
    }

    if (this._upgrade !== null) {
      this._resolveUpgradeRequest(req)
    }

    if (this._seeks.length > 0) {
      this._clearInflightSeeks(req)
    }

    if (this._reorgs.length > 0) {
      this._clearInflightReorgs(req)
    }

    if (this._seeks.length > 0 || this._ranges.length > 0) this._updateNonPrimary()
    else this.updatePeer(peer)
  }

  async _onreorgdata (peer, req, data) {
// console.log('onreorg', { ...req, peer: null })
    const f = this._addReorg(data.fork, peer)

    if (f === null) {
      this.updateAll()
      return
    }

    removeInflight(f.inflight, req)

    if (f.batch) {
      await f.batch.update(data)
    } else {
      f.batch = await this.core.tree.reorg(data)

      // Remove "older" reorgs in progress as we just verified this one.
      this._clearOldReorgs(f.fork)
    }

    if (f.batch.finished) {
      if (this._addUpgradeMaybe() !== null) {
        await this._applyReorg(f)
      }
    }

    this.updateAll()
  }

  async _applyReorg (f) {
    // TODO: more optimal here to check if potentially a better reorg
    // is available, ie higher fork, and request that one first.
    // This will request that one after this finishes, which is fine, but we
    // should investigate the complexity in going the other way

    const u = this._upgrade

    this._applyingReorg = true
    this._reorgs = [] // clear all as the nodes are against the old tree - easier

    try {
      await this.core.reorg(f.batch, null) // TODO: null should be the first/last peer?
    } catch (err) {
      u.listeners.reject(err)
    }

    this._applyingReorg = false
    this._resolveUpgradeRequest(null)

    for (const peer of this.peers) this._updateFork(peer)
  }

  _maybeUpdate () {
    return this._upgrade !== null && this._upgrade.inflight.length === 0
  }

  _updateFork (peer) {
    if (this._applyingReorg === true || this.allowFork === false || peer.remoteFork <= this.core.tree.fork) {
      return false
    }

    const f = this._addReorg(peer.remoteFork, peer)

    // TODO: one per peer is better
    if (f !== null && f.batch === null && f.inflight.length === 0) {
      return peer._requestForkProof(f)
    }

    return false
  }

  _updatePeer (peer) {
    if (peer.inflight >= peer.maxInflight) {
      return false
    }

    for (const s of this._seeks) {
      if (s.inflight.length > 0) continue // TODO: one per peer is better
      if (peer._requestSeek(s) === true) {
        return true
      }
    }

    // Implied that any block in the queue should be requested, no matter how many inflights
    const blks = new RandomIterator(this._queued)

    for (const b of blks) {
      if (b.queued === false || peer._requestBlock(b) === true) {
        b.queued = false
        blks.dequeue()
        return true
      }
    }

    return false
  }

  _updatePeerNonPrimary (peer) {
    const ranges = new RandomIterator(this._ranges)

    for (const r of ranges) {
      if (peer._requestRange(r) === true) {
        return true
      }
    }

    // Iterate from newest fork to oldest fork...
    for (let i = this._reorgs.length - 1; i >= 0; i--) {
      const f = this._reorgs[i]
      if (f.batch !== null && f.inflight.length === 0 && peer._requestForkRange(f) === true) {
        return true
      }
    }

    if (this._maybeUpdate() && peer._requestUpgrade(this._upgrade) === true) {
      return true
    }

    return false
  }

  updatePeer (peer) {
    // Quick shortcut to wait for flushing reorgs - not needed but less waisted requests
    if (this._applyingReorg === true) return

    while (this._updatePeer(peer) === true);
    while (this._updatePeerNonPrimary(peer) === true);
  }

  updateAll () {
    // Quick shortcut to wait for flushing reorgs - not needed but less waisted requests
    if (this._applyingReorg === true) return

    const peers = new RandomIterator(this.peers)

    for (const peer of peers) {
      if (this._updatePeer(peer) === true) {
        peers.requeue()
      }
    }

    // Check if we can skip the non primary check fully
    if (this._maybeUpdate() === false && this._ranges.length === 0 && this._reorgs.length === 0) {
      return
    }

    for (const peer of peers.restart()) {
      if (this._updatePeerNonPrimary(peer) === true) {
        peers.requeue()
      }
    }
  }

  attachTo (protocol) {
    const peer = new Peer(this, protocol)

    peer.alias = protocol.addPeer(this.discoveryKey, peer)

    protocol.open.send({
      id: peer.alias,
      discoveryKey: this.discoveryKey,
      capability: Buffer.alloc(32)
    })
  }
}

function pages (core) {
  const res = []

  for (let i = 0; i < core.tree.length; i += core.bitfield.pageSize) {
    const p = core.bitfield.page(i / core.bitfield.pageSize)
    res.push(p)
  }

  return res
}

function matchingRequest (req, data) {
  if (data.block !== null && (req.block === null || req.block.index !== data.block.index)) return false
  if (data.hash !== null && (req.hash === null || req.hash.index !== data.hash.index)) return false
  if (data.seek !== null && (req.seek === null || req.seek.bytes !== data.seek.bytes)) return false
  if (data.upgrade !== null && req.upgrade === null) return false
  return req.fork === data.fork
}

function removeInflight (inf, req) {
  const i = inf.indexOf(req)
  if (i === -1) return false
  if (i < inf.length - 1) inf[i] = inf.pop()
  else inf.pop()
  return true
}

function mapIndex (blocks, index) {
  return blocks === null ? index : blocks[index]
}
