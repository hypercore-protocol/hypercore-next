const sodium = require('sodium-universal')
const c = require('compact-encoding')

module.exports = class BlockEncryption {
  constructor (key) {
    this.key = key
    this.blindingKey = Buffer.alloc(sodium.crypto_stream_KEYBYTES)
    this.padding = 8

    sodium.crypto_generichash(this.blindingKey, this.key)
  }

  encrypt (index, block, fork) {
    const padding = block.subarray(0, this.padding)

    c.uint64.encode(
      { start: 0, end: padding.byteLength, buffer: padding },
      fork
    )

    // Blind the fork ID, possibly risking reusing the nonce on a reorg of the
    // Hypercore. This is fine as the blinding is best-effort and the latest
    // fork ID shared on replication anyway.
    this._xor(padding, nonce(index), this.blindingKey)

    // The combination of a fork ID and a block index is unique for a given
    // Hypercore and is therefore a valid nonce for encrypting the block.
    this._xor(block.subarray(this.padding), nonce(index, padding))
  }

  decrypt (index, block) {
    // Decrypt the block using the blinded fork ID.
    this._xor(block.subarray(this.padding), nonce(index, block.subarray(0, this.padding)))
  }

  _xor (buffer, nonce, key = this.key) {
    sodium.crypto_stream_xor(buffer, buffer, nonce, key)
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
