const { Readable } = require('streamx')

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
    if (this.index === this.end || (this.end === -1 && this.index >= this.feed.length)) {
      this.push(null)
      cb(null)
    } else {
      try {
        this.push(await this.feed.get(this.index++, this.options))
      } catch (err) {
        return cb(err)
      }
      cb(null)
    }
  }

  _destory (cb) {
    console.log('hello')
    cb(null)
  }
}

module.exports = {
  ReadStream
}
