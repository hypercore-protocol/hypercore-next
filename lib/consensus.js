const uint64le = require('uint64le')

module.exports = class {
  constructor (self) {
    this.self = self
  }

  verificationInfo () {
    return this.self.info.publicKey
  }

  signable () {
    return signable(this.self.hash(), this.self.length, this.self.fork)
  }

  signedBy (signature, key) {
    const self = this.self
    return signature && self.crypto.verify(self.signable(), signature, key)
  }
}

function signable (hash, length, fork) {
  const buf = Buffer.alloc(48)
  hash.copy(buf)
  uint64le.encode(length, buf, 32)
  uint64le.encode(fork, buf, 40)
  return buf
}
