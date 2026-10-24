#!/usr/bin/env bash
# Android emulator smoke for the native shell (spec 103, release.yml).
#
# WHY THIS IS A FILE AND NOT AN INLINE `script:`.
#
# `reactivecircus/android-emulator-runner` executes the `script:` input LINE BY LINE, each line in
# its own `sh -c`. That is invisible until something depends on it, and then it fails in two ways at
# once — which is exactly what happened the first time this smoke ever reached the emulator
# (2026-09-04, the v1.16.0 release):
#
#   [command]/usr/bin/sh -c PKG=$(grep … strings.xml)      ← sets PKG; that shell then exits
#   [command]/usr/bin/sh -c adb shell am start -n "$PKG/.MainActivity"
#                                → Starting: Intent { cmp=/.MainActivity }
#                                → Error: Activity class {/.MainActivity} does not exist.
#   [command]/usr/bin/sh -c for i in $(seq 1 60); do
#                                → Syntax error: end of file unexpected (expecting "done")
#
# A variable does not survive to the next line, and a multi-line `for`/`if` is split mid-statement.
# One file invoked by one line has neither problem, and can be read and reasoned about on its own.
#
# What this PROVES: the bundled app installs, launches, renders the shell (the `[fw-smoke]
# shell-mounted` marker reaches logcat through Capacitor's console bridge), and survives a
# background/foreground cycle without a fatal exception. The app-lock re-prompt itself is pinned at
# unit level (src/test/applock) and by the staged manual protocol — a fresh emulator has no
# signed-in member to lock, and pretending otherwise would be coverage that cannot fail (spec 094).
set -euo pipefail

cd frontend/android && ./gradlew --no-daemon assembleDebug && cd ../..

PKG=$(grep -oP '(?<=<string name="package_name">)[^<]+' frontend/android/app/src/main/res/values/strings.xml)
if [ -z "$PKG" ]; then
  echo "::error::Could not read package_name out of strings.xml — refusing to probe an app whose identity is unknown."
  exit 1
fi
echo "Probing $PKG"

adb install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -c || true
adb shell am start -n "$PKG/.MainActivity"

MOUNTED=false
for _ in $(seq 1 60); do
  if adb logcat -d | grep -q 'fw-smoke.*shell-mounted'; then MOUNTED=true; break; fi
  sleep 2
done
if [ "$MOUNTED" != "true" ]; then
  echo "::error::The app shell never mounted in the WebView — dumping the tail of logcat."
  adb logcat -d | tail -150
  exit 1
fi

adb shell input keyevent KEYCODE_HOME
sleep 2
adb shell am start -n "$PKG/.MainActivity"
sleep 5
if adb logcat -d | grep -q 'FATAL EXCEPTION'; then
  echo "::error::Fatal exception across the background/foreground cycle."
  adb logcat -d | grep -A 30 'FATAL EXCEPTION'
  exit 1
fi

echo "Smoke passed: installed, mounted, survived a lifecycle cycle."
