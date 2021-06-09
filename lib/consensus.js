const uint64le = require('uint64le')

module.exports = {
  verificationInfo (self) {
    return self.info.publicKey
  },
  signable (self) {
    return signable(self.hash(), self.length, self.fork)
  },
  signedBy (self, key) {
    return self.signature && self.crypto.verify(self.signable(), self.signature, key)
  }
}

function signable (hash, length, fork) {
  const buf = Buffer.alloc(48)
  hash.copy(buf)
  uint64le.encode(length, buf, 32)
  uint64le.encode(fork, buf, 40)
  return buf
}
