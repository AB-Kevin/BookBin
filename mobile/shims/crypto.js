// The part of Node's crypto the desktop's main-process code uses, for the
// Android web view.
module.exports = {
  randomUUID: () => globalThis.crypto.randomUUID(),
};
