const uint64le = require('uint64le')

const INFO_SIZE = 64 + 32 + 64 + 8

class Info {
  constructor (opts = {}) {
    this.secretKey = opts.secretKey || null
    this.publicKey = opts.publicKey || null
    this.signature = opts.signature || null
    this.fork = opts.fork !== undefined ? opts.fork : 0
  }

  encode () {
    const buf = Buffer.alloc(64 + 32 + 64 + 8)
    if (this.secretKey !== null) this.secretKey.copy(buf)
    this.publicKey.copy(buf, 64)
    if (this.signature) this.signature.copy(buf, 64 + 32)
    uint64le.encode(this.fork, buf, 64 + 32 + 64)
    return buf
  }

  static decode (buf) {
    return new this({
      secretKey: notZero(buf.slice(0, 64)),
      publicKey: buf.slice(64, 64 + 32),
      signature: notZero(buf.slice(64 + 32, 64 + 32 + 64)),
      fork: uint64le.decode(buf, 64 + 32 + 64)
    })
  }
}

class InfoStorage {
  constructor (storage) {
    this.storage = storage
    this.info = null
  }

  open () {
    return new Promise((resolve) => {
      this.storage.read(0, INFO_SIZE, (_, buf) => {
        if (buf) this.info = Info.decode(buf)
        else this.info = new Info()
        resolve()
      })
    })
  }

  static async open (storage) {
    const infoStorage = new InfoStorage(storage)
    await infoStorage.open()
    return infoStorage
  }

  encode () {
    return this.info.encode()
  }

  flush () {
    const buf = this.encode()
    return new Promise((resolve, reject) => {
      this.storage.write(0, buf, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }
}

module.exports = {
  Info,
  InfoStorage
}

function notZero (b) {
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0) return b
  }
  return null
}
