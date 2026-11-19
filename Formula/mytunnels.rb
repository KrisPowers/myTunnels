# The tap's formula. scripts/build.ps1 and the Release workflow point it at
# each release; the url lines name it and the sha256 under each is checked.
#
#   brew tap krispowers/mytunnels https://github.com/KrisPowers/myTunnels
#   brew install mytunnels

require "download_strategy"
require "utils/github"

# Fetches a release archive through GitHub's API, signed in, so a private
# repository's releases install too. The token is the one Homebrew finds:
# HOMEBREW_GITHUB_API_TOKEN, or gh's sign-in.
class GitHubReleaseDownloadStrategy < CurlDownloadStrategy
  def initialize(url, name, version, **meta)
    super
    match = url.match(%r{^https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/([^/]+)$})
    raise CurlDownloadStrategyError, "#{url} is not a release archive" unless match

    @owner, @repo, @tag, @file = match.captures
  end

  private

  def _fetch(url:, resolved_url:, timeout:)
    token = GitHub::API.credentials
    raise CurlDownloadStrategyError, "Sign in with `gh auth login`, or set HOMEBREW_GITHUB_API_TOKEN" if token.blank?

    release = GitHub::API.open_rest("#{GitHub::API_URL}/repos/#{@owner}/#{@repo}/releases/tags/#{@tag}")
    asset = release["assets"].find { |a| a["name"] == @file }
    raise CurlDownloadStrategyError, "Release #{@tag} has no #{@file}" unless asset

    curl_download asset["url"], "--header", "Accept: application/octet-stream",
                  "--header", "Authorization: Bearer #{token}", to: temporary_path, timeout: timeout
  end
end

class Mytunnels < Formula
  desc "Publish apps at home through Cloudflare Tunnel, with an access gateway"
  homepage "https://github.com/KrisPowers/myTunnels"
  version "0.1.83"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.83/macos-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "c932e696705f62e9ce7aac108d8c4fb839aff2db953146b2952921132c87103a"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.83/macos-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "85094d00ee62c81fb626da3dc5ece9d2571eba1fc01cfb829f071ff4c8d080c8"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.83/linux-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "0f59e5ef38bd52952cbe78bcf6c81b27960d6995302f3c1144c7281e3296e288"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.83/linux-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "9cd063e35c942152883f6c8e37e2837fc1034e3465f91b8bb5742bb088f19a44"
    end
  end

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"mytunnels"
  end

  # An upgrade starts a running myTunnels again on the new version.
  def post_install
    quiet_system bin/"mytunnels", "start" if quiet_system bin/"mytunnels", "status"
  end

  test do
    assert_match "not running", shell_output("#{bin}/mytunnels status", 1)
  end
end
