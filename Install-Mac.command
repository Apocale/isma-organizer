#!/bin/bash
# Isma Organizer: installer for macOS.
# Copies the panel into your Adobe extensions folder, lets Premiere load panels
# that are not signed (PlayerDebugMode), and checks for ffmpeg.
# No admin password. Nothing outside your user folder is changed.

if [ -t 1 ]; then DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'; else DIM=; BOLD=; OFF=; fi
say() {   # English, then the same in French, dimmed
  printf '%s\n' "$1"
  if [ -n "$2" ]; then printf '%s%s%s\n' "$DIM" "$2" "$OFF"; fi
}
finish() {
  echo
  read -r -p "Press Enter to close / Entrée pour fermer " _
  exit "${1:-0}"
}

clear
echo "${BOLD}ISMA ORGANIZER: install for Premiere Pro (Mac)${OFF}"
echo

HERE="$(cd "$(dirname "$0")" && pwd -P)"
SRC="$HERE/PremiereProOrganizer"
CEP="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$CEP/PremiereProOrganizer"

if [ ! -f "$SRC/CSXS/manifest.xml" ]; then
  say "[!] The PremiereProOrganizer folder is not next to this installer." \
      "[!] Le dossier PremiereProOrganizer n'est pas à côté de cet installateur."
  say "    Unzip the whole download, then open the installer from that folder." \
      "    Décompresse tout le téléchargement, puis lance l'installateur depuis ce dossier."
  finish 1
fi

# Premiere reads its panels when it starts. Only the app itself counts: helper
# processes (crash reporter, Dynamic Link) stay after it quits and also carry
# "Adobe Premiere Pro" in their path.
while pgrep -f "/Contents/MacOS/Adobe Premiere Pro" >/dev/null 2>&1; do
  say "[!] Premiere Pro is open. Quit it (Premiere Pro > Quit), then press Enter." \
      "[!] Premiere Pro est ouvert. Quitte-le, puis appuie sur Entrée."
  say "    To install anyway, type i then Enter, and restart Premiere afterwards." \
      "    Pour installer quand même, tape i puis Entrée, et relance Premiere ensuite."
  read -r answer
  case "$answer" in i|I) break ;; esac
done

if ! mkdir -p "$CEP"; then
  say "[!] Could not create the folder: $CEP" "[!] Impossible de créer le dossier ci-dessus."
  finish 1
fi

if [ "$(cd "$DEST" 2>/dev/null && pwd -P)" = "$SRC" ]; then
  # Unzipped straight into Adobe's folder: deleting the old copy would delete this one.
  say "[OK] The panel is already in Adobe's extensions folder." \
      "[OK] Le panneau est déjà dans le dossier des extensions d'Adobe."
else
  rm -rf "$DEST"
  if ! cp -R "$SRC" "$DEST"; then
    say "[!] The copy failed. Is the disk full?" "[!] La copie a échoué. Le disque est-il plein ?"
    finish 1
  fi
  # Development files, not needed inside Premiere
  rm -rf "$DEST/tests" "$DEST/tools" "$DEST/__pycache__"
  # A downloaded file carries Apple's quarantine flag. Premiere does not need it,
  # and it would block an ffmpeg placed in bin/.
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
  say "[OK] Panel copied to $DEST" "[OK] Panneau copié."
fi

# Before 2.6.0, the B-roll tab was a separate panel.
if [ -d "$CEP/PinterestBroll" ]; then
  rm -rf "$CEP/PinterestBroll"
  say "[OK] Removed the old Pinterest B-roll panel (it is now the B-roll tab)." \
      "[OK] Ancien panneau Pinterest B-roll retiré (c'est maintenant l'onglet B-roll)."
fi

# Another copy under another folder name: Premiere would load one of the two.
for m in "$CEP"/*/CSXS/manifest.xml "/Library/Application Support/Adobe/CEP/extensions"/*/CSXS/manifest.xml; do
  [ -f "$m" ] || continue
  d="${m%/CSXS/manifest.xml}"
  [ "$(cd "$d" && pwd -P)" = "$(cd "$DEST" && pwd -P)" ] && continue
  if grep -q 'com.OrganizeFilesInProject.panel' "$m" 2>/dev/null; then
    say "[!] Another copy of this panel is installed: $d" \
        "[!] Une autre copie de ce panneau est installée (dossier ci-dessus)."
    say "    Delete that folder, or Premiere may load the old one." \
        "    Supprime ce dossier, sinon Premiere risque de charger l'ancienne."
  fi
done

# Panels that are not signed load only with PlayerDebugMode, one setting per
# CEP version: 9 = Premiere 2020 … 12 = Premiere 2025 and 2026, and a few ahead.
for v in 9 10 11 12 13 14 15 16; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
say "[OK] Premiere can load panels that are not signed (PlayerDebugMode)." \
    "[OK] Premiere peut charger les panneaux non signés (PlayerDebugMode)."

# ffmpeg saves most Pinterest videos (picture and sound come separately).
# The same places the panel looks; Premiere does not see your Terminal's PATH.
FF=""
for f in "$DEST/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg; do
  if [ -x "$f" ]; then FF="$f"; break; fi
done
ELSEWHERE="$(command -v ffmpeg 2>/dev/null)"
echo
if [ -n "$FF" ]; then
  say "[OK] ffmpeg found: $FF" "[OK] ffmpeg trouvé."
elif [ -n "$ELSEWHERE" ]; then
  say "[i] ffmpeg is at $ELSEWHERE, where Premiere does not look." \
      "[i] ffmpeg est installé à un endroit où Premiere ne regarde pas."
  say "    Copy it into $DEST/bin/" "    Copie-le dans le dossier bin/ du panneau (chemin ci-dessus)."
else
  say "[i] Optional: ffmpeg is not installed. The B-roll tab needs it to save most Pinterest videos." \
      "[i] Facultatif : ffmpeg n'est pas installé. L'onglet B-roll en a besoin pour la plupart des vidéos Pinterest."
  say "    With Homebrew: brew install ffmpeg   (other ways: see the README)" \
      "    Avec Homebrew : brew install ffmpeg   (autres moyens : voir le README)"
fi

echo
say "${BOLD}Done. Open Premiere Pro, then Window > Extensions > Isma Organizer.${OFF}" \
    "C'est fini. Ouvre Premiere Pro, puis Fenêtre > Extensions > Isma Organizer."
finish 0
