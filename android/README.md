# ASB Android companion

Phase 7 provides the live session list, desktop filters, row menus, and Open
on PC through the ASB phone gateway. QR or manual pairing remains available.
The user checks the PC and certificate fingerprint before the app sends the
pairing request. Authenticated hello must succeed before the session list
opens. Connection information shows the real server name and ASB version.
Settings shows the connection, Persistent unread, the theme source, the view,
notification switches, background check controls, and licenses.
The app requests notification permission once after verified pairing. Settings
can request permission again or open Android notification settings.

Background checks use WorkManager with a 15-minute period and a connected network.
Android and HyperOS can delay these checks. Foreground updates save the attention
baseline without notifications. Background updates can show Done, Failed, and
Needs input notifications with Open on PC and Read actions. Unpair removes the
saved pairing and the app's notifications. Phone acceptance for Phase 7 is pending.

Pairing uses TLS 1.3 and the SHA-256 of the full certificate. The app stores
the paired token in one private SharedPreferences file. Backup and device
transfer are disabled. Network and response errors keep the saved pairing;
HTTP 401 marks it revoked. Unpair requires confirmation. The app sends no
bearer token on the pairing route, follows no redirects, and cancels network
calls when their coroutine is canceled. Pairing links and tokens are not logged.
The pairing input, confirmation, and running request survive screen rotation.
Back cancels the request. Unpair resets the retained pairing flow before a new
pairing starts; an old response cannot save credentials into that new flow.
Each pairing gets its own session ViewModel and API. The session screen owns
the lifecycle polling loop. Foreground dashboard reads share a mutex with
baseline updates; only the current, resumed pairing can save that baseline.

## Live notification

The live notification is an ongoing, silent notification with the session
counts, for example `5 sessions · 2 working · 1 pending`. Archived sessions are
not counted. Expand it to see the titles of the Working sessions (six titles,
then `+N more`). Tap it to open the app. Select Stop to turn it off. When
Android hides sensitive content on the lock screen, the lock screen shows only
the counts (and the offline status). When the PC does not answer, the
notification keeps the last counts and shows `Offline · last update 5m ago`.

A foreground service runs the notification. It is on by default after pairing.
Turn it on or off in Settings > Notifications > Live notification. The service
does not run while notifications are off for ASB. It starts again when the app
opens with notifications allowed. It also starts again after a phone restart
and after an app update. Unpair or a removed pairing stops it. While the session
screen is open, the screen updates the notification and the service sends no
requests. On the other screens of the app, the service reads the dashboard but
shows no alerts. In the background, while the phone is awake, the service reads
the dashboard every 5 seconds while a session is working, and every 30 seconds
when not or when the PC is offline. It shows Done, Failed, and Needs input
alerts after the read that finds them. When the screen is off, Android can put
the phone to sleep and delay these reads and alerts, sometimes by many minutes,
until the phone wakes again. When the service is off, the 15-minute background
check shows these alerts. When the service or the screen read the dashboard
less than one minute before, the 15-minute check does not read it again.

The service keeps the phone network in use and costs some battery. A 30-second
read with no change is small because the app sends the ETag. HyperOS can stop
the service or block its start after a restart. In app info, set Battery saver
to No restrictions and turn on Autostart.

## Away from home

The app can reach ASB on the home network (LAN) and through ZeroTier or
Tailscale. A pairing link can give one address for each kind. The pin and the
token are the same for all addresses. Pairing links from older PCs give one
home network address, and an existing pairing keeps its saved address. After
each successful hello, the app saves the address list that the PC sends.

A read (dashboard or hello) first uses the last address that answered. When
that address does not answer, the app tries the other addresses in this order:
home network, ZeroTier, Tailscale. Each address gets 3 seconds to connect. An
action or a setting goes to one address only. The app never sends it again to
another address, so an action cannot run two times. When Android changes the
default network, the next request starts again at the top of the order.

The connection text shows the path, for example `PC · Live · ZeroTier`. Tap
or hold the ASB disc in the top bar to see this text. Settings > Connection lists the addresses and marks the current one. When no address
answers and the pairing has a ZeroTier or Tailscale address, the error tells
you to turn on that app on the phone. Install and join ZeroTier or Tailscale on
the PC and on the phone to use ASB away from home.

## Themes, views, and motion

The app is dark only and follows the PC theme. The dashboard `palette` field
gives the colors of the PC window: the Custom colors or the GNOME colors. The
app saves the last palette and uses it at start and while offline. Before the
first palette, it uses a dark fallback. Settings shows the theme source as
read-only text.

The session cards use the desktop Compact and Comfortable views. Select the
view in Settings; the default is Comfortable. Compact rows are at least 48 dp
high for touch, and Comfortable rows are at least 68 dp. In Comfortable, the
card corner shows the Read target, the pin of a pinned row, the drawer glyph of
a drawer row, and the armed Discard ring. Tap a corner control to use it. Pin,
Put in drawer, and Discard result are in the long-press menu.

The app turns with the phone. A window narrower than 600 dp shows one list. A
wider window, for example landscape, shows the desktop Column Flow: 240 dp
target columns, filled down and then across, with horizontal scrolling. After
a rotation, the first visible session stays in view. Filters, search, the view,
and open sheets stay the same.

The top bar is one row with a 1 dp line under it. In one list, the row is 56 dp
high: the ASB disc, the Pending, Working, Drawer, and Filters pills, Search,
and Settings. A dot on the disc shows Live (success color) or Offline (muted
color). Tap or hold the disc to open a menu with the connection text and
Refresh. Pull the list down to refresh. Search replaces the disc and the pills
with a search field. Close search or Back clears the query and closes the
field. The field stays open while it has a query. In Column Flow, the row is 48
dp high: the disc, the connection text, a search field, the pills, and
Settings. Pull to refresh does not work in Column Flow, so use Refresh in the
disc menu. The pills scroll sideways and fade at the end when more pills are
there.

Cards move to new places with a critically damped spring of about 350 ms. New
cards fade in, and removed cards go at once. A press shows the palette
highlight. A view change or a new column layout shows at once, with no motion.
When Android animations are off, all motion is instant.

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
./gradlew --no-daemon -Pandroid.builder.sdkDownload=false assembleDebug
./gradlew --no-daemon -Pandroid.builder.sdkDownload=false testDebugUnitTest
./gradlew --no-daemon -Pandroid.builder.sdkDownload=false lint
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

The app uses Lifecycle 2.9.2 and WorkManager 2.10.2.
Networking and tests use OkHttp 4.12.0, kotlinx.serialization 1.9.0,
kotlinx.coroutines 1.10.2, Google code scanner 16.1.0, and JUnit 4.13.2.

The JVM tests use a real pinned TLS connection to MockWebServer. They cover
certificate rejection, bearer handling, revocation, ETags, JSON defaults and
long timestamps, path encoding, error handling, and cancellation while a
response body is still arriving. Pairing parser tests reject duplicate,
unknown, incomplete, malformed, and ambiguous fields.
Endpoint tests use two MockWebServers with one certificate. They cover version
1 and 2 links, the kind order, the read fallback, no second send of an action,
the network change reset, the hello address update, and the saved-host migration.
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
the disc within the adaptive icon's safe area. The notification icon uses
monochrome geometry from the same approved source. The app includes the
repository's MIT license in `app/src/main/assets/licenses/asb-LICENSE.txt`.

## Third-party assets

The Codex and Claude marks are the ASB desktop marks from `assets/icons/`
(Simple Icons, CC0). Brand rights remain with their owners.

Notification sounds use unchanged audio from opencode, commit
`fe87944b6ae85422db64c751b6d6ee488b0d7f1c`, under
`packages/ui/src/assets/audio/`: `staplebops-01.mp3` (Done),
`staplebops-02.mp3` (Needs input), and `nope-03.mp3` (Failed).
The source is MIT, Copyright (c) 2025 opencode. The app includes the exact
license in `app/src/main/assets/licenses/opencode-LICENSE.txt`.
The user can change each channel's sound in Android notification settings.
