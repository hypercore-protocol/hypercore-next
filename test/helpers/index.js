const Omega = require('../../')
const ram = require('random-access-memory')

module.exports = {
  async create (...args) {
    const o = new Omega(ram, ...args)
    await o.ready()
    return o
  },

  replicate (a, b, opts = {}) {
    const s1 = a.replicate(opts)
    const s2 = b.replicate(opts)
    s1.pipe(s2).pipe(s1)
    return [s1, s2]
  }
}
