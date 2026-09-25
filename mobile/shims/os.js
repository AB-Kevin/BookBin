// The part of Node's os the desktop's main-process code uses, for the
// Android web view.
module.exports = {
  tmpdir: () => '/tmp',
  homedir: () => '/home',
};
