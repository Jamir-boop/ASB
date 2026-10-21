{
  lib,
  stdenvNoCC,
  nodejs_24,
  makeWrapper,
  wrapGAppsHook4,
  gobject-introspection,
  gtk4,
  libadwaita,
  python3,
  xdg-utils,
  openssl,
  sqlite,
  pipewire,
  alsa-utils,
}:

let
  python = python3.withPackages (ps: [
    ps.pygobject3
    ps.pycairo
    ps.qrcode
  ]);
  # The programs that ASB starts: the certificate, the app links, the SQLite reader, and the sounds.
  tools = lib.makeBinPath [
    xdg-utils
    openssl
    sqlite
    pipewire
    alsa-utils
  ];
in
stdenvNoCC.mkDerivation {
  pname = "asb";
  version = (lib.importJSON ../package.json).version;
  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    nodejs_24
    makeWrapper
    wrapGAppsHook4
    gobject-introspection
  ];
  buildInputs = [
    gtk4
    libadwaita
  ];

  # The hook fills gappsWrapperArgs only before the fixup phase, so postFixup wraps the launcher by hand.
  dontWrapGApps = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    node scripts/asb-package.mjs stage $out/lib/asb
    install -Dm644 assets/icons/local.asb.AgentSwitchBoard.svg \
      $out/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg
    # Exec is a store path: a desktop session outside NixOS can lack the profile bin folder in PATH.
    install -Dm644 /dev/stdin $out/share/applications/local.asb.AgentSwitchBoard.desktop <<EOF
    [Desktop Entry]
    Type=Application
    Name=ASB
    GenericName=Agent Switch Board
    Exec=$out/bin/asb
    Icon=$out/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg
    Terminal=false
    StartupWMClass=local.asb.AgentSwitchBoard
    Categories=Development;
    EOF

    runHook postInstall
  '';

  # ASB_INSTALLED_LAUNCHER makes the tray, the user service, and the autostart entry start this wrapper again.
  postFixup = ''
    makeWrapper $out/lib/asb/scripts/asb $out/bin/asb \
      --set ASB_SYSTEM_INSTALL 1 \
      --set ASB_INSTALLED_LAUNCHER $out/bin/asb \
      --set ASB_NODE ${nodejs_24}/bin/node \
      --set ASB_PYTHON ${python}/bin/python3 \
      --prefix PATH : ${tools} \
      "''${gappsWrapperArgs[@]}"
  '';

  meta = {
    description = "Local session switch board for Codex and Claude Desktop Code";
    homepage = "https://github.com/Jamir-boop/ASB";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "asb";
  };
}
