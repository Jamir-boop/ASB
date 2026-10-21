import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FAMILIES, installCommand, nodeRoute } from '../src/linux-distros.mjs';

// A Windows checkout has CRLF line ends.
const text = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

// The keys that asb doctor lists as required and as optional on a system with nothing installed.
const REQUIRED = ['node', 'sqlite', 'openssl', 'xdg', 'gi', 'gtk', 'adw'];
const OPTIONAL = ['gicairo', 'qrcode', 'sound'];
const FLAKE = 'nix profile install github:Jamir-boop/ASB';

// The README install blocks: the code block after a line that ends with (family `name`), as [name, lines].
const familyBlocks = (readme) => [...readme.matchAll(/\(family `([a-z]+)`\)\n\n```bash\n([^`]*)```/g)]
  .map(([, name, body]) => [name, body.trimEnd().split('\n')]);

test('documents ASB installation, video, privacy limits, and upstream credit', async () => {
  const [readme, guide, privacy, changelog] = await Promise.all([
    text('../README.md'),
    text('../ASB.md'),
    text('../docs/PRIVACY.md'),
    text('../CHANGELOG.md'),
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
  assert.match(privacy, /^\| `~\/\.cache\/asb\/readers\/positions\.json` \| Engine reader positions\. For each Codex session log and each Claude transcript larger than 8 MiB:.*No message text, title, path, or folder name\. Mode `0600` in a `0700` folder\./m);
  assert.match(privacy, /The file has at most 5000 Codex records, 5000 Claude records, and 8 MiB\./);
  assert.match(privacy, /`%LOCALAPPDATA%\\asb\\cache` holds the reader positions file\. ASB limits these four folders/);
  assert.doesNotMatch(privacy, /transcript checkpoint/);
  assert.ok(readme.includes(`[Download v${version}](https://github.com/Jamir-boop/ASB/releases/tag/v${version})`));
  assert.ok(readme.includes(`[Release notes](docs/releases/v${version}.md)`));
  const releaseNotes = await text(`../docs/releases/v${version}.md`);
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

test('the README has one install block for each Linux family, equal to installCommand', async () => {
  const blocks = familyBlocks(await text('../README.md'));
  assert.deepEqual(blocks.map(([name]) => name), Object.keys(FAMILIES));
  for (const [name, lines] of blocks) {
    if (FAMILIES[name].packages === null) {
      // A family without packages gets the flake line.
      assert.equal(installCommand(name, REQUIRED), null, name);
      assert.deepEqual(lines, [FLAKE], name);
    } else {
      assert.deepEqual(lines, ['# Required', installCommand(name, REQUIRED).join(' '), '# Optional', installCommand(name, OPTIONAL).join(' ')], name);
    }
  }
});

test('the README blocks are the commands that asb doctor prints on a system with nothing installed', { skip: process.platform === 'win32' }, async () => {
  const [{ collect }, readme] = await Promise.all([import('../scripts/asb-doctor.mjs'), text('../README.md')]);
  const blocks = new Map(familyBlocks(readme));
  assert.equal(blocks.size, Object.keys(FAMILIES).length);
  for (const [name, family] of Object.entries(FAMILIES)) {
    const data = await collect({
      env: { PATH: '/nonexistent', ASB_PYTHON: '/nonexistent/python3' },
      node: null,
      read: async (file) => (file === '/etc/os-release' ? `ID=${family.ids[0]}\n` : ''),
      exists: async () => false,
      execFile: async () => { throw new Error('not found'); },
      find: async () => null,
    });
    const lines = blocks.get(name);
    if (family.packages === null) {
      assert.equal(data.commands.required, null, name);
      assert.deepEqual(lines, [FLAKE], name);
    } else {
      assert.deepEqual([lines[1], lines[3]], [data.commands.required.join(' '), data.commands.optional.join(' ')], name);
    }
  }
});

test('the README names the release packages and links only the files that the release has', async () => {
  const readme = await text('../README.md');
  const version = readme.match(/\[Download v(\d+\.\d+\.\d+)\]/)[1];
  // The release has five files: the .deb, the RPM, the archive, the PKGBUILD, and SHA256SUMS.
  const published = [`asb_${version}_all.deb`, `asb-${version}-1.noarch.rpm`, `asb-${version}-linux.tar.gz`, 'PKGBUILD', 'SHA256SUMS'];
  const files = [...readme.matchAll(new RegExp(`releases/download/v${version}/([^)\\s]+)`, 'g'))].map(([, file]) => file);
  for (const file of published) assert.ok(files.includes(file), file);
  for (const file of files) assert.ok(published.includes(file), file);
  for (const command of ['npm run build', 'rpmbuild', `sudo dnf install ./asb-${version}-1.noarch.rpm`, `sudo zypper install --allow-unsigned-rpm ./asb-${version}-1.noarch.rpm`,
    'makepkg -si', FLAKE]) assert.ok(readme.includes(command), command);
});

test('Install on Linux has the npm route, asb doctor, the family blocks, the release packages, engine only, autostart without systemd, and the firewall in this order', async () => {
  const readme = await text('../README.md');
  const section = readme.slice(readme.indexOf('## Install on Linux'), readme.indexOf('## Install on Windows'));
  let last = -1;
  for (const item of ['### Install with npm', 'npm install -g --install-links github:Jamir-boop/ASB', 'Keep `--install-links`', '### Check the system', '`asb doctor`',
    '### Packages for each distribution', '(family `debian`)', '### Release packages', '### Engine only', '### Start at login without systemd', '### Firewall']) {
    const index = section.indexOf(item, last + 1);
    assert.ok(index > last, `${item} is missing or out of order`);
    last = index;
  }
});

test('the Node.js section has the routes of nodeRoute, the search order of the launcher, and a link to the package blocks', async () => {
  const [readme, launcher] = await Promise.all([text('../README.md'), text('../scripts/asb')]);
  const section = readme.slice(readme.indexOf('\n## Node.js\n'), readme.indexOf('\n## Android companion'));
  const rhel = nodeRoute({ ID: 'almalinux', ID_LIKE: ['rhel', 'centos', 'fedora'], VERSION_ID: '9.8' }, 'fedora');
  assert.ok(section.includes(`\`sudo ${rhel.command.join(' ')}\``));
  for (const route of [nodeRoute({ ID: 'debian', VERSION_ID: '12' }, 'debian'), nodeRoute({ ID: 'steamos' }, null, { mode: 'readonly' })]) {
    for (const url of route.text.match(/https:\/\/[^\s,)]+/g)) assert.ok(section.includes(url), url);
  }
  // The four fixed paths come in the same order as in the candidate list of scripts/asb.
  const paths = ['~/.local/bin/node', '/home/linuxbrew/.linuxbrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  const inOrder = (source, names) => names.map((name) => source.indexOf(name)).every((index, i, all) => index >= 0 && (i === 0 || index > all[i - 1]));
  assert.ok(inOrder(section, paths));
  assert.ok(inOrder(launcher, paths.map((name) => name.replace('~', '$HOME'))));
  assert.ok(section.includes('(#packages-for-each-distribution)'));
});
