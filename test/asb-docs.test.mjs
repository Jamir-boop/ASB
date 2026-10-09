import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('documents ASB installation, video, privacy limits, and upstream credit', async () => {
  const [readme, guide, privacy, changelog] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../ASB.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/PRIVACY.md', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  ]);
  const download = readme.match(/\[Download v(\d+\.\d+\.\d+)\]/);
  assert.ok(download, 'README should name the published download version');
  const version = download[1];

  assert.match(readme, /!\[[^\]]*\]\(docs\/media\/asb-banner\.png\)/);
  assert.match(readme, /native GNOME switcher for your Codex and Claude Desktop Code chats/);
  assert.match(readme, /Select a chat to open it in its original app/);
  assert.match(readme, /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/mi);
  assert.match(privacy, /banner and Remotion demo use synthetic chats and folders/);
  assert.match(privacy, /not a capture of local conversations/);
  assert.ok(readme.includes(`[Download v${version}](https://github.com/Jamir-boop/ASB/releases/tag/v${version})`));
  assert.ok(readme.includes(`[Release notes](docs/releases/v${version}.md)`));
  const releaseNotes = await readFile(new URL(`../docs/releases/v${version}.md`, import.meta.url), 'utf8');
  assert.ok(releaseNotes.startsWith(`# ASB ${version}\n`));
  assert.ok(readme.includes(`https://github.com/Jamir-boop/ASB/releases/download/v${version}/SHA256SUMS`));
  assert.ok(readme.includes(`https://github.com/Jamir-boop/ASB/releases/download/v${version}/asb_${version}_all.deb`));
  assert.ok(readme.includes(`https://github.com/Jamir-boop/ASB/releases/download/v${version}/asb-${version}-linux.tar.gz`));
  assert.ok(readme.includes(`sudo apt install ./asb_${version}_all.deb`));
  assert.ok(readme.includes(`tar -xzf asb-${version}-linux.tar.gz`));
  assert.ok(readme.includes(`cd asb-${version}\n`));
  assert.ok(guide.includes(`for v${version} packages`));
  assert.match(readme, /Node\.js `>=20` \(`sqlite3` below `22\.13`\)/);
  assert.match(readme, /Python 3 with PyGObject, GTK `>=4\.12`, Libadwaita `>=1\.4`, and `xdg-utils`/);
  assert.match(readme, /working `codex:` and `claude:` URL handlers/);
  assert.match(readme, /## Install on Linux/);
  assert.match(readme, /\[User guide\]\(ASB\.md\).*\[Privacy\]\(docs\/PRIVACY\.md\).*\[Source setup\]\(ASB\.md#start-and-stop\).*\[Contributing\]\(CONTRIBUTING\.md\)/);
  assert.match(readme, /\[MIT license\]\(LICENSE\)/);
  assert.match(guide, /http:\/\/127\.0\.0\.1:4629\//);
  assert.match(guide, /Both modes bind only to `127\.0\.0\.1`/);
  assert.match(readme, /Agent Mission Control 0\.6\.0\]\(https:\/\/github\.com\/forxidian\/agent-mission-control\/releases\/tag\/v0\.6\.0\) by \*\*forxidian\*\*/);
  assert.match(changelog, /## Upstream history/);
});
