# Pets

`pets.json` has the pixel pets of the board setting **Pets** (Preferences > Appearance): a crab, a pigeon, and a cat. When the setting is on, a pet carries each message from the sender card to the receiver card. The board reads this file in `load_pets()` in `scripts/asb-native.py`.

The pets were drawn for ASB, with no outside source image. The crab is after the Claude Code mascot.

## Format

- `version`: `1`.
- `envelope`: the 8×6 letter that a pet carries. `palette` maps each grid key to a color. The key `A` is the board accent color.
- `pets`: one entry for each pet, by name.
  - `width`, `height`: the frame size in sprite pixels.
  - `anchor`: `[x, y]`, the point between the feet, on the floor.
  - `mirror`: `true` for a side-view pet. Each frame faces right, and the board mirrors it to face left. The crab is a front view and does not mirror.
  - `envelopeFront`: `true` when the board draws the envelope over the pet. Then it draws the pixels in `over` again (the beak or the mouth that holds the envelope).
  - `walkFps`: the walk frames for each second.
  - `palette`: a color for each grid key.
  - `frames`: `stand`, `walk1` to `walk4`, `crouch`, `air`, `air2`, `toss`, and `release`. In each frame, `grid` has `height` rows of `width` characters, and `.` is empty. `envelope` is the top-left of the envelope in frame pixels, or `null` when the pet holds nothing. Only `release` holds nothing: the pet uses it after the toss.
