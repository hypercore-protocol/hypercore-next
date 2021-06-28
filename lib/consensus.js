const uint64le = require('uint64le')

module.exports = {
  verificationInfo () {
    return this.info.publicKey
  },
  signable () {
    return signable(this.hash(), this.length, this.fork)
  },
  signedBy (key) {
    return this.signature && this.crypto.verify(this.signable(), this.signature, key)
  }
}

function signable (hash, length, fork) {
  const buf = Buffer.alloc(48)
  hash.copy(buf)
  uint64le.encode(length, buf, 32)
  uint64le.encode(fork, buf, 40)
  return buf
}
