const { Readable, Writable } = require('streamx')

class WriteStream extends Writable {
  constructor (feed, opts) {
    super()

    this.feed = feed
    this.maxBlockSize = (opts && opts.maxBlockSize) || 0
  }

  async _writev (batch, cb) {
    try {
      await this.feed.append(this.maxBlockSize ? this._ensureMaxSize(batch) : batch)
    } catch (err) {
      return cb(err)
    }
    cb(null)
  }

  _ensureMaxSize (batch) {
    for (let i = 0; i < batch.length; i++) {
      let blk = batch[i]
      if (blk.length > this.maxBlockSize) {
        const chunked = []
        while (blk.length > this.maxBlockSize) {
          chunked.push(blk.slice(0, this.maxBlockSize))
          blk = blk.slice(this.maxBlockSize)
        }
        if (blk.length) chunked.push(blk)
        batch.splice(i, 1, ...chunked)
        i += chunked.length - 1
      }
    }
    return batch
  }
}

class ReadStream extends Readable {
  constructor (feed, opts = {}) {
    super()

    this.feed = feed
    this.start = opts.start || 0
    this.end = typeof opts.end === 'number' ? opts.end : -1
    this.live = !!opts.live
    this.snapshot = opts.snapshot !== false
    this.tail = !!opts.tail
    this.index = this.start
    this.options = { wait: opts.wait !== false, ifAvailable: !!opts.ifAvailable, valueEncoding: opts.valueEncoding }
    this.ctr = 0
  }

  async _open (cb) {
    try {
      await this.feed.ready()
      if (this.end === -1) {
        if (this.live) this.end = Infinity
        else if (this.snapshot) this.end = this.feed.length
        if (this.start > this.end) this.push(null)
      }
      if (this.tail) this.start = this.feed.length
      this.index = this.start
    } catch (err) {
      return cb(err)
    }
    cb(null)
  }

  async _read (cb) {
    let data = null
    if (this.index === this.end || (this.end === -1 && this.index >= this.feed.length)) {
      this.push(null)
    } else {
      let data = null

      try {
        data = await this.feed.get(this.index++, this.options)
      } catch (err) {
        return cb(err)
      }

      this.push(data)
    }
    cb(null)
  }

  _destroy (cb) {
    cb(null)
  }
}

module.exports = {
  WriteStream,
  ReadStream
}
