# Provider marks

These SVG paths come from the selected ASB Column Flow preview. The board loads them as file icons (`set_icon()` in `scripts/asb-native.py`), so GTK recolors them with the board CSS. The icon search path still has them for other lookups.

- OpenAI mark: [Simple Icons 13.0.0](https://raw.githubusercontent.com/simple-icons/simple-icons/13.0.0/icons/openai.svg).
- Claude mark: [Simple Icons](https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/claude.svg).
- OpenCode mark: the OpenCode logo, from [`packages/ui/src/assets/favicon/favicon.svg`](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/ui/src/assets/favicon/favicon.svg) at tag `v2.0.32` of anomalyco/opencode.
- Machine glyph (`asb-machine-symbolic.svg`), terminal glyph (`asb-terminal-symbolic.svg`), and drawer glyph (`asb-drawer-symbolic.svg`): drawn for ASB, no outside source.
- Mute glyph (`asb-muted-symbolic.svg`, an outline bell with a slash): drawn for ASB, no outside source.
- Copy kind glyphs (`asb-link-symbolic.svg`, two hollow rounded links, rotated -45 degrees; `asb-globe-symbolic.svg`, a globe with an equator and one meridian): drawn for ASB, no outside source.
- Windows icon `asb.ico`: the ASB icon `local.asb.AgentSwitchBoard.svg` as PNG images at 16, 32, 48, and 256 px in one ICO file. The Start menu link that `asb engine install` writes uses it.

Simple Icons publishes its icon collection under CC0. The marks identify the original apps. Brand rights remain with their owners. ASB changes only the SVG size and symbolic foreground fill.

OpenCode publishes its logo under the MIT License, Copyright (c) 2025 opencode. ASB changes only the crop and the gray fill. Brand rights stay with the owner.
