// Makes Buffer a global in the Android bundle, as it is in Node (see
// scripts/build-mobile.js, which injects this into every module).
export { Buffer } from 'buffer';
