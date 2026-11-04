# Provider marks

These SVG paths come from the selected ASB Column Flow preview. The board loads them as file icons (`set_icon()` in `scripts/asb-native.py`), so GTK recolors them with the board CSS. The icon search path still has them for other lookups.

- OpenAI mark: [Simple Icons 13.0.0](https://raw.githubusercontent.com/simple-icons/simple-icons/13.0.0/icons/openai.svg).
- Claude mark: [Simple Icons](https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/claude.svg).
- OpenCode mark: the OpenCode logo, from [`packages/ui/src/assets/favicon/favicon.svg`](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/ui/src/assets/favicon/favicon.svg) at tag `v2.0.32` of anomalyco/opencode.
- Machine glyph (`asb-machine-symbolic.svg`), terminal glyph (`asb-terminal-symbolic.svg`), drawer glyph (`asb-drawer-symbolic.svg`), and filter glyph (`asb-filter-symbolic.svg`): drawn for ASB, no outside source.
- Mute glyph (`asb-muted-symbolic.svg`, an outline bell of 2 px lines on the 16 px grid with a 2 px slash from corner to corner): drawn for ASB, no outside source. The drawer glyph is also a tray of 2 px lines with a 2 px handle.
- Messages glyph (`asb-chat-symbolic.svg`, an outline speech bubble; the top-bar extension has a byte copy): drawn for ASB, no outside source.
- Row panel messages glyph (`asb-messages-symbolic.svg`, an outline speech bubble with a 2 px stroke and straight edges on whole pixels at 14 px, for **Show messages**): drawn for ASB, no outside source.
- Filled drawer glyph (`asb-drawer-filled-symbolic.svg`, the drawer tray filled, with the handle cut out; the card drawer button of a row in the drawer): drawn for ASB, no outside source.
- Row panel glyphs: Keep (`asb-keep-symbolic.svg`, a solid ring, 12 px outer with a 2 px stroke at 14 px (outer radius 6.857, inner radius 4.571)), Discard (`asb-discard-symbolic.svg`, the same ring in 8 equal 27° sectors with 18° gaps (60% ink), the first centered at the top), and Unpin (`asb-unpin-symbolic.svg`, a filled pin with the slash cut out and a 1 px clear gap on each side at 14 px): drawn for ASB, no outside source.
- Pin glyphs (`asb-pin-symbolic.svg`, the filled pin of `asb-unpin-symbolic.svg` without its slash: head bar, body, base bar, and needle; `asb-pin-outline-symbolic.svg`, a 12 px whole-pixel outline pin: a 2 px filled head, 1 px body outline and base, a clear 2 by 3 px core, and a 1 by 3 px needle; its silhouette stays within 1 px of the filled pin at 12 px): drawn for ASB, no outside source. The card corner shows the filled pin on a pinned row and the outline pin on an unpinned row; the Compact pin mark and the row panel **Pin** row use the filled pin.
- Copy kind glyphs (`asb-link-symbolic.svg`, two hollow rounded links, rotated -45 degrees; `asb-globe-symbolic.svg`, a globe with an equator and one meridian): drawn for ASB, no outside source.
- Windows icon `asb.ico`: the ASB icon `local.asb.AgentSwitchBoard.svg` as PNG images at 16, 32, 48, and 256 px in one ICO file. The Start menu link that `asb engine install` writes uses it.

Simple Icons publishes its icon collection under CC0. The marks identify the original apps. Brand rights remain with their owners. ASB changes only the SVG size and symbolic foreground fill.

OpenCode publishes its logo under the MIT License, Copyright (c) 2025 opencode. ASB changes only the crop and the gray fill. Brand rights stay with the owner.
