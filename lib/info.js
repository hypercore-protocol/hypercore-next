const uint64le = require('uint64le')
const cenc = require('compact-encoding')

const infoEncoding = {
  preencode (state, i) {
    cenc.fixed64.preencode(state, i.secretKey)
    cenc.fixed32.preencode(state, i.publicKey)
    cenc.buffer.preencode(state, i.signature)
    cenc.uint.preencode(state, i.fork)
    return state
  },
  encode (state, i) {
    cenc.fixed64.encode(state, i.secretKey || Buffer.alloc(0))
    cenc.fixed32.encode(state, i.publicKey)
    cenc.buffer.encode(state, i.signature)
    cenc.uint.encode(state, i.fork)
    return state
  },
  decode (state) {
    return {
      secretKey: cenc.fixed64.decode(state),
      publicKey: cenc.fixed32.decode(state),
      signature: cenc.buffer.decode(state),
      fork: cenc.uint.decode(state)
    }
  }
}

module.exports = class Info {
  constructor (storage) {
    this.storage = storage
    this.secretKey = null
    this.publicKey = null
    this.signature = null
    this.fork = 0
  }

  async _keygen ({ crypto, secretKey, publicKey }) {
    if (!this.publicKey) {
      if (publicKey) {
        this.publicKey = publicKey
        this.secretKey = secretKey || null
      } else {
        const keys = crypto.keyPair()
        this.publicKey = keys.publicKey
        this.secretKey = keys.secretKey
      }
      await this.flush()
    } else if (publicKey && !this.publicKey.equals(publicKey)) {
      throw new Error('Another hypercore is stored here')
    }
  }

  async open (opts) {
    await new Promise((resolve) => {
      this.storage.read(0, 64 + 32 + 64 + 8, (_, buf) => {
        if (buf) {
          const info = cenc.decode(infoEncoding, buf)

          this.secretKey = notZero(info.secretKey)
          this.publicKey = info.publicKey
          this.signature = notZero(info.signature)
          this.fork = info.fork
        }
        resolve()
      })
    })
    return this._keygen(opts)
  }

  static async open (storage, opts) {
    const info = new Info(storage)
    await info.open(opts)
    return info
  }

  commit () {
    return cenc.encode(infoEncoding, this)
  }

  close () {
    return new Promise((resolve, reject) => {
      this.storage.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  flush () {
    const buf = this.commit()
    return new Promise((resolve, reject) => {
      this.storage.write(0, buf, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }
}

function notZero (b) {
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0) return b
  }
  return null
}
