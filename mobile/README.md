# Dodge Blitz

A small native mobile arcade game, built twice: once in Swift for iOS and once
in Kotlin for Android. Same game design, idiomatic implementation on each
platform.

**Gameplay:** drag to steer your ship left/right, dodge the falling obstacles,
and survive as long as possible. Score climbs with survival time; obstacles
spawn faster and fall quicker the longer you last. Your best score is saved
on-device. Tap anywhere to restart after a game over.

## iOS (`ios/`)

SwiftUI host view (`ContentView`) embedding a SpriteKit `GameScene` that owns
the game loop, physics-based collision detection, and rendering.

- `DodgeBlitzApp.swift` — app entry point
- `ContentView.swift` — SwiftUI wrapper around the SpriteKit scene
- `GameScene.swift` — game loop, spawning, difficulty ramp, collisions, score

The project is described with an [XcodeGen](https://github.com/yonaskolb/XcodeGen)
spec (`project.yml`) rather than a checked-in `.xcodeproj`, so it stays
diffable in plain text. To open it in Xcode:

```bash
brew install xcodegen   # if you don't have it
cd mobile/ios
xcodegen generate
open DodgeBlitz.xcodeproj
```

Requires Xcode 15+, targets iOS 16+.

## Android (`android/`)

A standard Gradle/Kotlin project. `GameView` is a `SurfaceView` running its
own render thread (`Runnable`) for the game loop, drawing directly with
`Canvas`/`Paint` — no game engine dependency.

- `MainActivity.kt` — hosts the `GameView`, wires lifecycle to pause/resume
- `GameView.kt` — game loop, spawning, difficulty ramp, collisions, score,
  high-score persistence via `SharedPreferences`

To build:

```bash
cd mobile/android
gradle wrapper   # generates gradlew/gradlew.bat + wrapper jar (one-time)
./gradlew installDebug
```

Or just open the `mobile/android` folder directly in Android Studio, which
will offer to set up the Gradle wrapper for you automatically.

Requires JDK 17, Android SDK (compileSdk 34), targets minSdk 24+.
