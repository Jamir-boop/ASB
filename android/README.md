# ASB Android companion

Phase 7 provides the live session list, desktop filters, the session
inspector, and Open on PC through the ASB phone gateway. Select **Scan QR
code** in the app to scan the pairing QR code. The phone camera or any QR
scanner app also works: the `asb://pair` link opens ASB on the Check the PC
screen. A pasted pairing link works the same way. When
the app is already paired, the link changes nothing and a short message says
to unpair first.
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
Needs input notifications with Open on PC and Mark read actions.
The words match the card: the title is the card state word and the machine
(`Needs your answer · studio-pc`, `Waiting for approval · studio-pc`,
`Failed · studio-pc`, `Usage limit · studio-pc`, `Done · studio-pc`), the text
is the card title (or `Untitled session`), and the subtext is the app. When 2
or more show, they share one app group with the app's own summary, which counts
the alerts, then each kind (`3 alerts: 1 needs input · 1 failed · 1 done`); the summary posts also while the
app is open, because a group with no summary is one that Android auto-groups.
While the PC switch for message text is on, the PC sends the pending question
(`questionText`), and the Needs input notification shows it as expanded text.
When the switch goes off or the question is gone, the next good read posts the
notification again without the question, with no sound and at its old time.
Only the private version has the question; the public version keeps `ASB` and
the kind only: `A session needs your answer`, `A task failed`, `A task hit a
usage limit`, or `A task is done` (the group summary and the Connection
notification keep `A session needs attention`). Each switch in Settings has a
caption with what it covers, the same text as its channel description. The Live
notification text has two groups, `Pending: ` with up to 3 pending titles (in the cards' order)
and `+N more`, then `Working: ` with the working titles and `+N more`; a group with no rows is left out. The title
leaves out a zero count (`13 pending`, `2 working`). Its public version keeps only the counts. On a locked phone, Android shows the version
without the question when the phone setting hides sensitive notification
content; otherwise the lock screen shows the question too. The app keeps the
question text in memory, never in the saved preferences or a log line, but
Android keeps a posted notification and can give it to notification history, to
apps with notification access, and to a paired watch.
**Check now** also shows these notifications while the app is open. An automatic
check while the app is open does not save the baseline. Unpair removes the
saved pairing and the app's notifications. Phone acceptance for Phase 7 is pending.

A background read (the live service or the check) also cancels the notification
of each kind whose mark is clear on the row now, for example Done after the user
read the session on the PC. Android keeps about 50 notifications for one app and
then drops new ones, so old notifications must go. The mark on the row decides,
not a change since the last read: when the user reads a session while the app is
open, its notification goes at the first read after the app goes to the
background. A session that is missing from the read and a first read with no
saved baseline keep their notifications. A second result of the same session
between two reads (the mark stays set, the result time is newer) posts again.
A usage limit does not hide a mark: a
task that a usage limit stops posts a Failed notification with the title
`Usage limit` once, and the reset posts nothing. A read from an engine other
than the paired PC also keeps the notifications of sessions of other machines,
because that engine starts the row of such a session with no mark. A read from
the paired PC cancels them like the notifications of local sessions. The
session screen cancels nothing.

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
counts, for example `1 pending · 2 working`, with no count of all sessions.
Archived sessions are not counted. Expand it to see the titles of the Working sessions, one on each
line (six titles, then `+N more`). Tap it to open the app. Select Stop to turn
it off. When Android hides sensitive content on the lock screen, the lock screen
shows only the counts (and the offline status). When the PC does not answer, the
notification keeps the last counts and shows `Offline · last update 5m ago`.

On Android 16, the notification can use Live updates. HyperOS can show it
in its island. The chip has a small icon and a short text. For 8 seconds after a
session gets the Done mark, the chip shows a check mark in a ring and `Done`.
After that, it shows the number of pending sessions. The icon is a question mark
in a ring when a pending session needs input, and a filled disc when not. When
no session is pending, the chip shows the number of working sessions with an
open ring. After the Done time, when no session is pending or working, the
notification is not a Live update, and the status bar shows the ASB icon.
The same applies when the PC does not answer. A phone without Live updates or
an island has no chip. It shows the same notification and the same small icon.

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
another address, so an action cannot run two times. The pairing request has no
token and tries the addresses of the pairing link in the same order, like a read.
The PC accepts a pairing code one time only, so a second address cannot add a
second phone: a used code gets the message `This pairing code is not valid. Make
a new one in ASB.` When Android changes the default network, the next request
starts again at the top of the order.

A network change (for example when you turn on ZeroTier on the phone) also
drops the idle connections of the old network, and the session screen and the
live notification read the dashboard at once. They do not wait for the offline
delay. When the PC does not answer yet (a new VPN can need a few seconds), the
next try comes after 3 seconds, then the normal delays. The session screen
waits 3, 5, 10, and then 30 seconds after the last good read; the live
notification waits 30 seconds. When the PC restarts phone access and closes the
open connections, a read that fails on such a connection tries once more on a
new connection (never an action), so the app reconnects at once. A change of
only the PC message text switch does not restart phone access. A
change while the app is in the background also counts when the session screen
opens again. The first good read after a network change also reads hello, so
an address that you select later on the PC (for example ZeroTier) reaches the
phone without a new pairing. The app also reads hello at each start. The PC
starts to listen on a selected address within 30 seconds after it appears.

The connection text shows the path, for example `PC · Live · ZeroTier`. Tap
or hold the ASB disc in the top bar to see this text. Settings > Connection lists the addresses and marks the current one. When no address
answers and the pairing has a ZeroTier or Tailscale address, the error tells
you to turn on that app on the phone. Install and join ZeroTier or Tailscale on
the PC and on the phone to use ASB away from home.

## Several machines

In a machine group, the phone learns the other ASB engines of the group from
hello. When the paired PC does not answer, the app uses another engine of the
group, with the same token and the pinned certificate of that engine. While it
uses another engine, it checks the paired PC once a minute and goes back to it
when it answers again. An action goes only to the engine that showed the list.
Cards of sessions on another machine and CLI sessions are view only: they show
the machine name or `CLI` before the age, and a tap says where the session
runs. Settings > Connection lists the machines with Online or Offline and marks
the one in use.

## Messages and Usage

The **Messages** and **Usage** screens show the agent messages and the token
usage of all machines of the group. Open them from the ⋮
main menu of the sessions screen (**Messages**, **Usage**, **Settings**).
**Show messages** in the session panel opens Messages with that session
selected. Messages counts the Claude Code and ASB Bridge messages. It shows the
round table of the 12 most recent sessions (TalkBack reaches each seat in circle
order), the selected seat or pair, and the ledger. A seat label never sits on a
chord: with no free place it hides, and the panel under the table names the
selected seat with its Outgoing and Incoming counts. The per-day (or per-hour)
line under the Messages total shows its scale (`max 48/day`). Busiest pairs
names are cut at their end, and each row is at least 48 dp high. A selected pair
shows its counts on one line (`→ 115  ← 115`). Usage shows the cost and the tokens by machine, app, model, provider, and session,
for periods up to `All time`, with the price line in the top bar and `Reading usage` while the PC reads the transcripts.
Messages first opens on `24 hours`, and Usage on `All time`. Each screen keeps
the chosen period over a rotation.
The screens read `/phone/v1/activity/messages` and `/phone/v1/activity/usage`
every 10 seconds while they show (Usage `All time`: every 60 seconds). Usage
reads every 2 seconds while the scan runs or the prices load. When the PC runs an
older ASB, `All time` shows
`This PC runs an older ASB. Update ASB on the PC to see All time.`
The Messages and Usage reports have counts, statuses, session titles, and token
usage, never message text: the gateway asks the PC for the messages with `text=0`.
The gateway has the thread route `/phone/v1/activity/thread` (with message text)
only while the PC owner turns on the PC switch for message text (off by default);
`hello` reports it as `sendText`. When a seat or a pair is selected, the phone
asks the hello of that engine first. With `sendText: true`, it loads the thread
as the PC thread view does (`seat=` or `a=` and `b=`, the period, `limit=100`)
and shows each message with its from and to names, its time, its status when it
is not accepted, and its text (`Text not available` without a copy), newest
last. A thread opens at its newest message, as on the PC, and its head (the seat or the pair) stays at the
top of the screen while the thread is in view; `Show earlier` loads
up to 200 and keeps the message in view in its place. The text stays in screen memory only: never
in the saved settings, a file, or a log. With the switch off, the thread shows
`Message text is off on the PC. Turn it on in ASB Preferences > Phone.` and makes
no thread request. A PC with no switch (older ASB) or a 404 shows the older-PC
message, and every other error reply (for example the gateway 502
`The ASB reply is too large.`) shows its error, never an empty thread. A thread
that is too long to load offers `Show fewer messages` (the newest 50). A message
body shows six lines; `Show more` shows the rest and `Show less` folds it again.
TalkBack names each button for its message (`Show more of the message from docs
at 14:05`). When message text goes off on
the PC, the open thread hides its text at the next report.
Under the Messages status bar, a tap on the status list or its `Show meanings`
button shows what each status means under its word (the PC tooltip sentences); a
second tap or `Hide meanings` hides them. TalkBack reads the sentence with each
status, and the button is the one action of the list.

The Usage chart keeps 8 % headroom above the tallest bar on the round axis
steps. Its x labels are at even steps (24 hours: every 6 hours on the hour; 7
days: each day), and the axis labels get the room that their text needs. A tap
on a bar or its column shows the PC box above or beside the bar: the title,
Total, and the series from high to low. A horizontal drag over the plot moves the
box to the bar under the finger; a vertical drag scrolls the page. A current bucket that is still running has a lighter fill and says so far. TalkBack reads a summary
(`Usage over time, 24 hours. Highest: 14:00, $1.20.`) and reaches each bar
with its time and values, as the PC tooltip. The gateway also forwards the `mute` and
`unmute` row actions.

## Themes, views, and motion

The app is dark only and follows the PC theme. The dashboard `palette` field
gives the colors of the PC window: the Custom colors or the GNOME colors. The
app saves the last palette and uses it at start and while offline. Before the
first palette, it uses a dark fallback. Settings shows the theme source as
read-only text.

The app is fullscreen: the system bars hide, and a swipe from an edge shows
them for a moment. Settings > Appearance > **Use the camera area** is on by
default, so the app also draws under the camera hole. Turn it off to keep the
camera band clear.

The session cards use the desktop Compact and Comfortable views. Select the
view in Settings; the default is Comfortable. Compact rows are at least 48 dp
high for touch, and Comfortable rows are at least 68 dp. In Comfortable, the
title takes 1 or 2 lines and the state line follows it, and a row with no title
shows `Untitled session`, as on the PC. The card corner shows the Read target,
the pin of a pinned row, the drawer glyph of a drawer row, and the armed **Mark
read when done** ring. A pinned Compact row with no mark shows a small pin in the
mark cell. Each corner control has its own 48 dp touch target, and
the folder and title lines end before the controls. The pin slot is at the end
and the Read slot left of it, so they keep their places. The marks are `?` for a
question or an approval, `!` for a failure, and a clock in the same disc for a
usage limit stop; TalkBack reads their meaning (`Needs your answer`, `Waiting for
approval`, `Failed`, `Usage limit`, `Done, unread`). Tap a corner control to use
it. Pin, Put in drawer, and **Mark read when done** are in the session
inspector.

A Working row has a small dot before `Working` that pulses (1.6 s) in the
Working color, and its working time updates each 30 s. The pulse runs only
while the list shows and the app is in view; with Android animations off, the
dot is still. TalkBack reads no change. While Offline, the dot is still and
`Working` has the caption color.

Settings > Appearance > **Pets** is Off by default. Select a pixel crab,
pigeon, or cat to carry each message from card to card, as on the PC. Pets and
message lights draw under the card text, so they never cover it. The stage
below the choices shows this motion. With animations off, the 2 marks light
instead.

Touch and hold a card to open the session inspector at that point. It shows
the provider, folder, title, and state, and an **Open on <machine>** button with
the app on a second line. Below it are the **Unread**, **Pinned**, and **In the
drawer** switches, **Pin order** (**Earlier** and **Later**) for a pinned row,
and **Mark read when done** for a Working row. A control that the row does not
allow is dimmed, TalkBack says that it is disabled, and a line under it says
why (for example `ASB does not open CLI sessions.`). **Copy reference** copies
the absolute reference of the row (`asb:1/...`), and the button says `Copied`
with a check for a moment, as on the PC;
when the PC has no reference for the row, the button is dimmed with the reason.
**Mute** offers the PC times as five chips of one width, three then two (`30 min`, `1 hour`, `8 hours`, `1 day`, `Always`),
each with the time over its end (`1 hour` over `until 22:41`; `1 day` over `until Thu`; TalkBack reads the
full end); a muted row shows an **Unmute**
button with `Muted until 14:30` (or `Muted`), and its card shows the muted bell and
`Muted until 14:30` (or `Muted`) after the folder. The inspector
stays open after a change and shows the new row data. An action error shows
as a caption below the switches; other messages show in the message pill over the
panel. After Mute or Unmute the panel keeps its top edge. Back, a tap outside, Open, or the row leaving the list closes it.

After a good Open, `Opened on <PC>` shows in a small dark pill under the top
bar (and its band and chip row). All other messages and errors show in the same
pill; while the Offline band shows, the pill does not repeat its error, and while
the inspector is open, the pill shows over it. A tap closes it. The
inspector has a scrim behind it.

Settings > Card marks explains each card mark.

The app turns with the phone. A window narrower than 600 dp shows one list. A
wider window, for example landscape, shows the desktop Column Flow: 240 dp
target columns, filled down and then across, with horizontal scrolling. After
a rotation, the first visible session stays in view. Filters, search, the view,
and open sheets stay the same.

The top bar has a 1 dp line under it. In one list, it has two rows. The first
row is at least 48 dp high: the ASB disc, the connection text, Search, and
Settings. The second row has the Pending, Working, Drawer, and Filters pills,
so all four show in full on a 384 dp wide phone with two-digit counts. A pill
shows its count when it is 1 or more (`Pending 4`, spoken `Pending, 4
sessions`; at 0 it shows no number and is spoken `Pending, 0 sessions`): the rows that the pill shows when it is on with no other filter
on. The search and the other filters do not change the counts; only Include
archived does. TalkBack reads the Filters pill as `Filters, 2 on` while two
Filters sheet values are on. While Offline the counts are the last known ones, dimmed on the unselected pills; a selected pill keeps its count in the label color, as on the PC. A
filled dot on the disc shows Live (success color); a hollow ring shows Offline
(muted color). Tap or hold the disc to open a menu with the connection text,
`Last update 12m ago`, and Refresh (Retry while Offline). Pull the list down to refresh. Search
replaces the first row with a search field. The field stays open while it has
a query. In Column Flow, the top bar is one row, at least 48 dp high: the disc,
the connection text, a search field, the pills, and Settings. With large text,
the rows, the pills, and the search field get taller. Pull to refresh does not
work in Column Flow, so use Refresh in the disc menu. The pills scroll sideways
and fade at the end when more pills are there.

When a filter is on, a chip row under the top bar shows one chip for each
Filters sheet value: each chosen state, the app, and Include archived. A value
that a pill sets (Pending, Working, Drawer) has no chip, because its pill shows it.
A chip is a button: a tap on `Remove filter: Idle` removes that filter; the last chip, `Clear filters`, removes all of them and keeps the
search. As Esc and × on the board, Close search clears the search and all
filters. Back with an open search or a filter on clears them first; the next
Back leaves the screen.

While the app is Offline, a band under the top bar says `Offline · last update
12m ago` (only `Offline` before the first good read) and `No alerts until the
PC answers.`, with a Retry button that does what Refresh does. The age moves
each minute. TalkBack reads `Offline. No alerts until the PC answers.` once
when the band shows, and does not read the age again when it changes. A session on a group
machine that is not reachable shows Unknown, and its card description and
inspector say why (`travel-laptop is not reachable.`), as the board tooltip
and row panel.

Over the Pending rows of the list (Comfortable and Compact), a small header
says `Pending`; the Pending pill has the count. While a search is set, a row that matches only by its
folder path shows that path (with `~` for a usual home folder, cut in the
middle when it is long) in place of the project name. An empty list says `No
sessions on studio-pc.` with a Refresh button (while Offline, no Refresh: the band's Retry is the action); no result says `No sessions
match the search and filters.` with a `Clear search and filters` button. When
the PC removed the phone, the screen says `studio-pc removed this phone.`, how
to make a new pairing link on the PC, and `Pair again`.

Cards move to new places with a critically damped spring of about 350 ms. New
cards fade in, and removed cards go at once. A press shows the palette
highlight. A view change or a new column layout shows at once, with no motion.
When Android animations are off, all motion is instant.

The app has its own QR scanner and uses no Google Play services. Scan QR code
asks for the camera permission the first time. The scanner shows the back
camera with CameraX and reads the code with ZXing on the phone. It uses the
same review as a pasted link, so the Check the PC screen opens next. If the user
denies the camera, or the camera cannot open (for example a device policy turns
it off), the screen says to paste the link. If another app uses the camera, the
scanner waits for it. The camera is used only while the scanner is open. Frames are not saved
or sent. The camera is not required to install the app. The
`asb://pair` intent filter lets the phone camera open the pairing link in ASB.
A small activity with no window takes the link and gives it to the open app,
like a notification tap does. A tap on the launcher icon keeps a permission
dialog or a settings page that is open over the app.

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
/usr/local/bin/adb -s <serial> shell am start -n io.github.jamir_boop.asb/local.asb.companion.MainActivity
```

Use the debug build for development. Install the release build on the phone
for daily use:

```bash
./gradlew --no-daemon -Pandroid.builder.sdkDownload=false assembleRelease
/usr/local/bin/adb -s <serial> install -r app/build/outputs/apk/release/app-release.apk
```

Open the app and use it (scroll the list) for about one minute. Then compile
the app with its profile:

```bash
/usr/local/bin/adb -s <serial> shell cmd package compile -m speed-profile -f io.github.jamir_boop.asb
```

The debug build is much slower. The measured 99th-percentile frame time was
125 ms for the debug build and 10 ms for the release build with the compiled
profile. The release build uses R8 without resource shrinking, because the
notification sounds are found by name.

Without `keystore.properties`, the release build is signed with the debug key
of the PC that builds it. Thus it installs over the debug build from the same
PC and keeps the pairing. An APK with a different key (another PC, the release
key, or F-Droid) does not install over it: uninstall the app and pair again.

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. The app ID is
`io.github.jamir_boop.asb`, version name is `0.1.0`, and version code is `1`.
The Kotlin package and the namespace stay `local.asb.companion`.
Before this ID, the app ID was `local.asb.companion`. The new ID installs as a
new app beside the old one. Pair the new app again, then uninstall the old one.

The build turns off the AGP dependency metadata (`dependenciesInfo`), so the
APK has no dependency block that only Google can read.

The minimum SDK is 29. The compile and target SDK are 36.

AGP can print `WARNING: platform-tools package is not installed.` with this
setup. The APK build works without that package. Use the external `adb`
commands above for the device check.

## Release signing

The release key is a file that you make yourself, outside git. Make it once:

```bash
keytool -genkeypair -v -keystore ~/keys/asb-release.jks -alias asb \
  -keyalg RSA -keysize 4096 -validity 10000
```

Create `android/keystore.properties` (git ignores it). `storeFile` is
relative to `android/`, or an absolute path:

```properties
storeFile=/home/<user>/keys/asb-release.jks
storePassword=<store password>
keyAlias=asb
keyPassword=<key password>
```

When this file exists, `assembleRelease` signs with that key. Without it, the
debug key signs the release build. Back up the key and its passwords offline.
Without the key, you cannot publish updates of the app.

Check the signed APK. The DN must not be `CN=Android Debug`:

```bash
~/Android/Sdk/build-tools/36.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

## Release

Android releases have their own tags, `android-v<versionName>` (for example
`android-v0.1.0`). The desktop tags stay `v<version>`.

1. Increase `versionCode` and set `versionName` in `app/build.gradle.kts`.
   Keep them as literals: F-Droid reads them with a regular expression.
2. Add `app/fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`
   (at most 500 characters).
3. Merge to `main`.
4. Tag that `main` commit `android-vX.Y.Z` and push the tag.
5. Build the signed release APK with `assembleRelease` and check it with
   `apksigner`.
6. Attach `app-release.apk` to the GitHub release of the tag.

The store text and the icon for F-Droid are in
`app/fastlane/metadata/android/en-US/`.

## F-Droid

This is the draft recipe for `metadata/io.github.jamir_boop.asb.yml` in
fdroiddata. F-Droid builds the APK from source and signs it with its own key.
It removes the `signingConfig` line of the release build first, so keep that
line in its one-token form. In `commit`, put the full hash of the
`android-v0.1.0` tag commit (`git rev-parse 'android-v0.1.0^{commit}'`).
The root `package.json` has no lock file, so the recipe tells the scanner to
ignore it.

```yaml
Categories:
  - Development
License: MIT
AuthorName: jamir-boop
SourceCode: https://github.com/Jamir-boop/ASB
IssueTracker: https://github.com/Jamir-boop/ASB/issues
Changelog: https://github.com/Jamir-boop/ASB/blob/HEAD/CHANGELOG.md

RepoType: git
Repo: https://github.com/Jamir-boop/ASB.git

Builds:
  - versionName: 0.1.0
    versionCode: 1
    commit: <full hash of the android-v0.1.0 tag commit>
    subdir: android/app
    gradle:
      - yes
    scanignore:
      - package.json

AutoUpdateMode: Version
UpdateCheckMode: Tags ^android-v.*$
CurrentVersion: 0.1.0
CurrentVersionCode: 1
```

## Build versions

| Component | Version |
| --- | --- |
| Gradle | 8.14.3 |
| Android Gradle plugin | 8.11.1 |
| Kotlin and Kotlin plugins | 2.2.0 |
| Compose BOM | 2025.07.00 |
| Activity Compose | 1.10.1 |
| SDK Build Tools | 36.0.0 |

The app uses Lifecycle 2.9.2 and WorkManager 2.10.2. The QR scanner uses
CameraX 1.6.2 (`camera-camera2`, `camera-lifecycle`, and `camera-view`) and
ZXing core 3.5.3. Both are Apache-2.0.
Networking and tests use OkHttp 4.12.0, kotlinx.serialization 1.9.0,
kotlinx.coroutines 1.10.2, and JUnit 4.13.2.

The JVM tests use a real pinned TLS connection to MockWebServer. They cover
certificate rejection, bearer handling, revocation, ETags, JSON defaults and
long timestamps, path encoding, error handling, and cancellation while a
response body is still arriving. Pairing parser tests reject duplicate,
unknown, incomplete, malformed, and ambiguous fields.
Endpoint tests use two MockWebServers with one certificate. They cover version
1 and 2 links, the kind order, the read fallback, the pairing fallback, no second
send of an action, the network change reset, the hello address update, and the
saved-host migration.
Session tests check that a network change wakes the offline poll at once,
retries after 3 seconds, and reads hello after the next good dashboard.
Retained-flow tests cover ViewModelStore recreation, Back cancellation,
unpair/re-pair, responses from an old flow, and a new link while a request
runs. Link tests check that only a VIEW intent with an `asb://pair` URI starts
a review. Scanner tests decode a QR code made with ZXing, also with padded
rows, and check that the scanner state closes on a result, Back, and unpair.

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
monochrome geometry from the same approved source. The view-only card glyphs
`ic_machine.xml` and `ic_terminal.xml` use the paths of
`assets/icons/asb-machine-symbolic.svg` and `asb-terminal-symbolic.svg`, which
were drawn for ASB with no outside source. The app includes the
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
