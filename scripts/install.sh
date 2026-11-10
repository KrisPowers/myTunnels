#!/bin/sh
# Installs myTunnels on Linux or macOS, or updates it:
#
#   curl -fsSL -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github.raw" \
#     https://api.github.com/repos/KrisPowers/myTunnels/contents/scripts/install.sh | sh
#
# The program, cloudflared and the panel go in ~/.local/share/myTunnels/bin,
# with `mytunnels` linked into ~/.local/bin. Nothing needs root. The release
# is fetched signed in, with GH_TOKEN, GITHUB_TOKEN or gh's sign-in, since the
# repository is private.
set -eu

repo=KrisPowers/myTunnels
home="$HOME/.local/share/myTunnels"
links="$HOME/.local/bin"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "myTunnels installs on Linux and macOS here; on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "myTunnels has no build for $(uname -m)" >&2; exit 1 ;;
esac
# A Mac with Apple silicon reports x86_64 to a shell running under Rosetta.
if [ "$os" = macos ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi

mkdir -p "$home" "$links"
new="$(mktemp -d "$home/.new.XXXXXX")"
trap 'rm -rf "$new"' EXIT
file="$os-$arch.tar.gz"
token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$token" ] && command -v gh > /dev/null 2>&1; then token="$(gh auth token 2>/dev/null || true)"; fi
echo "Downloading myTunnels for $os-$arch"
if [ -n "$token" ]; then
  # The latest release's archive, by its API address, which takes the token.
  auth="Authorization: Bearer $token"
  release="$(curl -fsSL -H "$auth" "https://api.github.com/repos/$repo/releases/latest")"
  asset="$(printf '%s' "$release" \
    | grep -oE '"(url|name)": *"[^"]*"' \
    | awk -F'": *' -v want="\"$file\"" '/^"url"/ && /\/releases\/assets\// { u = $2 } /^"name"/ && $2 == want { gsub(/"/, "", u); print u; exit }')"
  if [ -z "$asset" ]; then echo "The latest release has no build for $os-$arch" >&2; exit 1; fi
  # curl leaves the token off when GitHub sends it on to its file storage.
  curl -fsSL -H "$auth" -H "Accept: application/octet-stream" "$asset" | tar -xz -C "$new"
else
  release="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest")"
  curl -fsSL "https://github.com/$repo/releases/latest/download/$file" | tar -xz -C "$new"
fi
# The release in place, which the panel compares with the latest to offer an update.
printf '%s' "$release" | grep -oE '"tag_name": *"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/' > "$new/release"

# An update stops the one running, swaps the files, then starts it again.
running=false
if [ -x "$home/bin/mytunnels" ]; then
  if "$home/bin/mytunnels" status > /dev/null 2>&1; then running=true; fi
  "$home/bin/mytunnels" stop > /dev/null 2>&1 || true
fi
rm -rf "$home/bin.old"
if [ -d "$home/bin" ]; then mv "$home/bin" "$home/bin.old"; fi
mv "$new" "$home/bin"
rm -rf "$home/bin.old"
ln -sf "$home/bin/mytunnels" "$links/mytunnels"

# ~/.local/bin on PATH for new terminals, when it is not already.
case ":$PATH:" in
  *":$links:"*) command="mytunnels" ;;
  *)
    command="$links/mytunnels"
    line='export PATH="$HOME/.local/bin:$PATH"'
    # zsh, the shell macOS opens, reads only its own file.
    always="$HOME/.profile"
    if [ "$os" = macos ]; then always="$always $HOME/.zshrc"; fi
    for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$profile" ] || case " $always " in *" $profile "*) true ;; *) false ;; esac; then
        grep -qsF "$line" "$profile" || printf '\n%s\n' "$line" >> "$profile"
      fi
    done
    ;;
esac

if [ "$running" = true ]; then
  "$home/bin/mytunnels" start
else
  echo "myTunnels is installed. Start it, now and with this computer from then on:"
  echo
  echo "  $command start"
fi
