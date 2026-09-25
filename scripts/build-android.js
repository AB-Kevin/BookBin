#!/usr/bin/env node
// Builds the Android APK into dist/.
//
//   node scripts/build-android.js           signed release: dist/BookBin-<version>.apk
//   node scripts/build-android.js --debug   debug build, signed with the SDK's
//                                           throwaway key, for trying things out
//   node scripts/build-android.js --run     debug build, installed and started on
//                                           the connected phone or emulator (set
//                                           ANDROID_SERIAL to pick one of several)
//
// A release build needs the signing key: android/keystore.properties locally,
// or the ANDROID_KEYSTORE_* environment variables in CI (see
// android/app/build.gradle). Without it the APK comes out unsigned and this
// stops rather than hand over a file no phone will install.
//
// Java and the Android SDK are found from JAVA_HOME / ANDROID_HOME, falling
// back to the copies Android Studio installs, so a machine with Android
// Studio needs no further setup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const IS_WINDOWS = process.platform === 'win32';
const runOnDevice = process.argv.includes('--run');
const debug = runOnDevice || process.argv.includes('--debug');
const { version } = require(path.join(ROOT, 'package.json'));

function firstExisting(candidates) {
  return candidates.find((p) => p && fs.existsSync(p));
}

const env = { ...process.env };

if (!env.JAVA_HOME) {
  const studioJdk = firstExisting([
    IS_WINDOWS && 'C:\\Program Files\\Android\\Android Studio\\jbr',
    process.platform === 'darwin' && '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    process.platform === 'linux' && '/opt/android-studio/jbr',
  ]);
  if (studioJdk) env.JAVA_HOME = studioJdk;
}

if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
  const sdk = firstExisting([
    IS_WINDOWS && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.platform === 'darwin' && path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    process.platform === 'linux' && path.join(os.homedir(), 'Android', 'Sdk'),
  ]);
  if (sdk) env.ANDROID_HOME = sdk;
}

if (!env.JAVA_HOME) throw new Error('No Java found. Install Android Studio, or set JAVA_HOME to a JDK 21 or newer.');
if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) throw new Error('No Android SDK found. Install Android Studio, or set ANDROID_HOME.');

// .cmd/.bat files (npx, gradlew.bat) only run through cmd.exe on Windows.
function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(' ')}`);
  const [file, fileArgs] = IS_WINDOWS ? ['cmd.exe', ['/c', command, ...args]] : [command, args];
  execFileSync(file, fileArgs, { cwd, env, stdio: 'inherit' });
}

require('./build-mobile');
run(IS_WINDOWS ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android'], ROOT);
run(IS_WINDOWS ? '.\\gradlew.bat' : './gradlew', [debug ? 'assembleDebug' : 'assembleRelease'], ANDROID);

const buildType = debug ? 'debug' : 'release';
const apkName = `BookBin-${version}${debug ? '-debug' : ''}.apk`;
const built = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', buildType, apkName);
if (!fs.existsSync(built)) {
  const unsigned = path.join(path.dirname(built), `BookBin-${version}-unsigned.apk`);
  throw new Error(fs.existsSync(unsigned) || !debug
    ? 'The release APK was not signed: add android/keystore.properties or the ANDROID_KEYSTORE_* variables.'
    : `Gradle finished but ${built} is missing.`);
}

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(built, path.join(outDir, apkName));
console.log(`\nBuilt dist/${apkName}`);

if (runOnDevice) {
  // adb is a plain .exe, so it is called directly rather than through cmd.exe,
  // which would split an SDK path that has a space in it.
  const adb = path.join(env.ANDROID_HOME || env.ANDROID_SDK_ROOT, 'platform-tools', IS_WINDOWS ? 'adb.exe' : 'adb');
  const devices = execFileSync(adb, ['devices'], { env, encoding: 'utf8' })
    .split('\n').slice(1).filter((line) => /\tdevice\s*$/.test(line));
  if (devices.length === 0) {
    throw new Error('No phone or emulator connected. Plug in a phone with USB debugging on (and accept its prompt), or start an emulator.');
  }
  if (devices.length > 1 && !env.ANDROID_SERIAL) {
    throw new Error(`More than one device is connected. Set ANDROID_SERIAL to one of:\n${devices.map((d) => `  ${d.split('\t')[0]}`).join('\n')}`);
  }

  console.log('> adb install -r', apkName);
  try {
    execFileSync(adb, ['install', '-r', built], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr || ''}`;
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(output)) {
      throw new Error(
        'The phone already has BookBin signed with a different key (a release APK). ' +
        'Uninstall BookBin from the phone, then run this again.'
      );
    }
    throw new Error(`adb install failed:\n${output}`);
  }
  execFileSync(adb, ['shell', 'am', 'start', '-n', 'com.bookbin.app/.MainActivity'], { env, stdio: 'ignore' });
  console.log('Installed and started BookBin on the device. Inspect it at chrome://inspect in Chrome.');
}
