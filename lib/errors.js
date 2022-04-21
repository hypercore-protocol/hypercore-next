class StorageEmpty extends Error {
  constructor () {
    super('No Hypercore is stored here')
    this.code = 'STORAGE_EMPTY'
  }
}

class StorageConflict extends Error {
  constructor () {
    super('Another Hypercore is stored here')
    this.code = 'STORAGE_CONFLICT'
  }
}

class InvalidSignature extends Error {
  constructor () {
    super('Remote sent invalid signature')
    this.code = 'INVALID_SIGNATURE'
  }
}

class InvalidCapability extends Error {
  constructor () {
    super('Remote sent invalid capability')
    this.code = 'INVALID_CAPABILITY'
  }
}

class SnapshotNotAvailable extends Error {
  constructor () {
    super('Snapshot is not available')
    this.code = 'NOT_AVAILABLE'
  }
}

class RequestCancelled extends Error {
  constructor () {
    super('Request cancelled')
    this.code = 'CANCELLED'
  }
}

class SessionNotWritable extends Error {
  constructor () {
    super('Session is not writable')
    this.code = 'NOT_WRITABLE'
  }
}

class SessionClosed extends Error {
  constructor () {
    super('Session is closed')
    this.code = 'CLOSED'
  }
}

class BadArgument extends Error {
  constructor (msg) {
    super(msg)
    this.code = 'BAD_ARGUMENT'
  }
}

module.exports = {
  StorageEmpty,
  StorageConflict,
  InvalidSignature,
  InvalidCapability,
  SnapshotNotAvailable,
  RequestCancelled,
  SessionNotWritable,
  SessionClosed,
  BadArgument
}
