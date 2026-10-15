# ASB Android companion

Phase 5 provides QR or manual pairing with the ASB phone gateway. The user
checks the PC and certificate fingerprint before the app sends the pairing
request. A successful connection shows the server name and ASB version from
the authenticated hello API. The Material 3 theme follows the system light
or dark setting. The session list and notifications are not implemented yet.

Pairing uses TLS 1.3 and the SHA-256 of the full certificate. The app stores
the paired token in one private SharedPreferences file. Backup and device
transfer are disabled. Network and response errors keep the saved pairing;
HTTP 401 marks it revoked. Unpair requires confirmation. The app sends no
bearer token on the pairing route, follows no redirects, and cancels network
calls when their coroutine is canceled. Pairing links and tokens are not logged.
The pairing input, confirmation, and running request survive screen rotation.
Back cancels the request. Unpair resets the retained pairing flow before a new
pairing starts; an old response cannot save credentials into that new flow.

The QR scanner needs Google Play services and can download its scanner module
on first use. Manual paste works when the scanner is unavailable.

## Requirements

- JDK 21. The build uses Java and Kotlin target 17.
- Android command-line tools in `$HOME/Android/Sdk/cmdline-tools/latest`.
- Android SDK platform 36 and Build Tools 36.0.0.
- The existing `/usr/local/bin/adb` for device checks. Do not install another
  platform-tools package for this setup.

On Debian, the user installs the JDK:

```bash
sudo apt install openjdk-21-jdk-headless
```

For a new command-line tools installation, use the
[pinned Linux archive](https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip).
Keep any existing SDK installation. Run these commands only when the `latest`
folder and the temporary `cmdline-tools` folder do not exist:

```bash
mkdir -p ~/Android/Sdk/cmdline-tools /tmp/asb-android-dl
curl -fL -o /tmp/asb-android-dl/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q /tmp/asb-android-dl/cmdline-tools.zip -d /tmp/asb-android-dl
mv /tmp/asb-android-dl/cmdline-tools ~/Android/Sdk/cmdline-tools/latest
```

The user must read and accept the SDK licenses:

```bash
~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root="$HOME/Android/Sdk" --licenses
```

After license acceptance, install the two SDK packages:

```bash
~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root="$HOME/Android/Sdk" "platforms;android-36" "build-tools;36.0.0"
```

Create `android/local.properties` with the local SDK path. This file is ignored:

```properties
sdk.dir=/home/<user>/Android/Sdk
```

## Build and device check

From `android/`:

```bash
./gradlew --no-daemon assembleDebug
./gradlew --no-daemon -Pandroid.builder.sdkDownload=false testDebugUnitTest
/usr/local/bin/adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
/usr/local/bin/adb -s <serial> shell am start -n local.asb.companion/.MainActivity
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. The app ID is
`local.asb.companion`, version name is `0.1.0`, and version code is `1`.
The minimum SDK is 29. The compile and target SDK are 36.

AGP can print `WARNING: platform-tools package is not installed.` with this
setup. The APK build works without that package. Use the external `adb`
commands above for the device check.

## Build versions

| Component | Version |
| --- | --- |
| Gradle | 8.14.3 |
| Android Gradle plugin | 8.11.1 |
| Kotlin and Kotlin plugins | 2.2.0 |
| Compose BOM | 2025.07.00 |
| Activity Compose | 1.10.1 |
| SDK Build Tools | 36.0.0 |

The version catalog also pins Lifecycle 2.9.2 and WorkManager 2.10.2 for later
phases. Phase 5 uses OkHttp 4.12.0, kotlinx.serialization 1.9.0,
kotlinx.coroutines 1.10.2, Google code scanner 16.1.0, and JUnit 4.13.2.

The JVM tests use a real pinned TLS connection to MockWebServer. They cover
certificate rejection, bearer handling, revocation, ETags, JSON defaults and
long timestamps, path encoding, error handling, and cancellation while a
response body is still arriving. Pairing parser tests reject duplicate,
unknown, incomplete, malformed, and ambiguous fields.
Retained-flow tests cover ViewModelStore recreation, Back cancellation,
unpair/re-pair, and responses or scanner callbacks from an old flow.

`buildToolsVersion` is set to `36.0.0` to use the installed package. AGP
8.11.1 otherwise selects Build Tools 35.0.0 by default. JDK 21 runs Gradle;
the build does not request or download a JDK 17 toolchain.

The Gradle 8.14.3 archive was checked against its
[official SHA-256](https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256)
before execution. The wrapper pins this checksum in
`gradle/wrapper/gradle-wrapper.properties`:

```text
bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531
```

## Assets

The launcher uses the approved Palatine disc from
`assets/icons/local.asb.AgentSwitchBoard.svg`. GdkPixbuf (with the installed
librsvg SVG loader) renders the unchanged source to the 432 × 432 RGBA file
`app/src/main/res/drawable-nodpi/ic_launcher_disc.png`. This keeps its masks,
gradients, and screen blending. The foreground XML adds a 21 dp inset to keep
the disc within the adaptive icon's safe area. The app uses the repository's
MIT license. No third-party sounds are included yet.
