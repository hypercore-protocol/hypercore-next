module.exports = class Stats {
  constructor (opts = {}) {
    this.size = opts.size || 0
  }

  static async from (core, padding, snapshot) {
    return new Stats({
      size: getSize(core, padding, snapshot)
    })
  }
}

function getSize (core, padding, snapshot) {
  return snapshot
    ? snapshot.byteLength
    : (core === null ? 0 : core.tree.byteLength - (core.tree.length * padding))
}
