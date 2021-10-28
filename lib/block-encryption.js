const sodium = require('sodium-universal')
const c = require('compact-encoding')

module.exports = class BlockEncryption {
  constructor (key) {
    this.key = key
    this.padding = 8
  }

  encrypt (index, block) {
    const padding = block.subarray(0, this.padding)
    this
      ._xor(block.subarray(this.padding), nonce(index, padding))
      ._xor(padding, nonce(index))
  }

  decrypt (index, block) {
    const padding = block.subarray(0, this.padding)
    this
      ._xor(padding, nonce(index))
      ._xor(block.subarray(this.padding), nonce(index, padding))
  }

  _xor (buffer, nonce) {
    sodium.crypto_stream_xor(buffer, buffer, nonce, this.key)
    return this
  }
}

const nonceBuf = Buffer.alloc(sodium.crypto_stream_NONCEBYTES)

function nonce (index, rest) {
  const state = { start: 0, end: nonceBuf.byteLength, buffer: nonceBuf }

  c.uint64.encode(state, index)
  if (rest) c.raw.encode(state, rest)

  // Zero out the remainder of the nonce
  nonceBuf.fill(0, state.start)

  return nonceBuf
}
