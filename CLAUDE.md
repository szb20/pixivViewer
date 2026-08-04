# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build APK

Building a standalone APK (runs independently on phone, no dev server needed) must use `CAP_BUILD=1`:

```bash
CAP_BUILD=1 npx cap sync android && cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Without `CAP_BUILD=1`, the Capacitor config (`capacitor.config.ts`) sets `server.url` to `http://192.168.1.2:5182`, causing the app to try connecting to the Vite dev server on the host machine — the APK will show a blank/error page when not on the same network.
