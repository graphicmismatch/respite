# Respite

A weird little Aseprite-style pixel art editor for Android tablets (and anything with a browser).

- Project manager home screen: thumbnails, rename, duplicate, delete, autosave
- Pencil, eraser, fill, eyedropper, line, rectangle, select and move tools
- Pen pressure (size and/or opacity, adjustable curve), palm rejection, fingers and passive styluses welcome
- Layers, frames, onion skin and playback
- Aseprite-style color picker with FG/BG, HSV/RGB sliders and palette
- Floating, resizable panels on tablets; docked panels on phones
- Import PNGs and spritesheets; export frames and spritesheets as PNG

Plain HTML/Canvas/JS in `www/`, no build step. Wrapped for Android with [Capacitor](https://capacitorjs.com).

## Run

```sh
npm install
npm test          # core logic checks
npm run serve     # browser version at http://localhost:8080
JAVA_HOME=/path/to/jdk-21 npm run apk   # debug APK in android/app/build/outputs/apk/debug/
```

The Android build needs JDK 21 and an Android SDK (`android/local.properties` → `sdk.dir=...`).

## License

MIT © graphicmismatch. Bundled icons and fonts are credited in [NOTICE](NOTICE).
