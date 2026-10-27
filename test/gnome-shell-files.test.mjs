import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {MACHINE_HUES, providerIcon} from '../gnome-shell/model.js';

const read = async path => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('GNOME symbolic icons are byte copies of the board icons', async () => {
  for (const name of ['chat', 'claude', 'openai', 'opencode']) {
    const filename = `asb-${name}-symbolic.svg`;
    assert.deepEqual(await readFile(new URL(`../gnome-shell/icons/${filename}`, import.meta.url)),
      await readFile(new URL(`../assets/icons/${filename}`, import.meta.url)));
  }
});

test('machine hues and provider file names match the native board rules', async () => {
  const board = await read('../scripts/asb-native.py');
  assert.deepEqual(MACHINE_HUES, [...board.match(/^MACHINE_HUES = \(([^\n]+)\)/m)[1].matchAll(/"(#[a-f0-9]{6})"/g)].map(m => m[1]));
  const rule = board.match(/def provider_icon\(provider\):\n\s+return \{([^\n]+)\}\.get\(provider, "([^"]+)"\)/);
  const providers = Object.fromEntries([...rule[1].matchAll(/"([^"]+)": "([^"]+)"/g)].map(m => [m[1], m[2]]));
  for (const provider of ['codex', 'opencode', 'claude-desktop-code', 'unknown'])
    assert.equal(providerIcon(provider), `${providers[provider] || rule[2]}.svg`);
});

test('metadata matches the extension contract exactly', async () => {
  assert.deepEqual(JSON.parse(await read('../gnome-shell/metadata.json')), {
    uuid: 'asb@jamir-boop.github.io', name: 'ASB',
    description: 'Shows in the top bar how many ASB sessions need you, how many are working, and the number of sessions on all your machines. Needs ASB (Agent Switch Board).',
    'shell-version': ['45', '46', '47', '48', '49'], url: 'https://github.com/Jamir-boop/ASB',
  });
});

test('model is pure and the extension uses only allowed GNOME modules', async () => {
  const model = await read('../gnome-shell/model.js');
  assert.doesNotMatch(model, /(?:gi|resource):\/\//);
  const extension = await read('../gnome-shell/extension.js');
  const imports = [...extension.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  const allowed = ['./model.js', ...['Clutter', 'Gio', 'GLib', 'GObject', 'Pango', 'Shell', 'Soup?version=3.0', 'St'].map(m => `gi://${m}`),
    'resource:///org/gnome/shell/extensions/extension.js', ...['main', 'panelMenu', 'popupMenu'].map(m => `resource:///org/gnome/shell/ui/${m}.js`)];
  assert.ok(imports.includes('./model.js'));
  for (const name of imports) assert.ok(allowed.includes(name), name);
  assert.doesNotMatch(extension, /\bimport\s*\(/);
});
