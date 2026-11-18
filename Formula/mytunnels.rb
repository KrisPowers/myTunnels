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
  version "0.1.57"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.57/macos-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "a35cb11ccfb7297a5c8590fff3f1c0370b8125dacf673663c728069eb071bb23"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.57/macos-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "059c7710a6376305b009f4c22b5513bde2e937c18899ccb005c9c122037d32d2"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.57/linux-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "f73e550f679d6c62f78b729cca0c0017a94fb8d3636579c4bf49c5d3b5a0094c"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.57/linux-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "e0c48c10188773059fb7390e95e1b4385fcadc26afe39df9f9feadcd74a1f213"
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
