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
  version "0.1.79"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.79/macos-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "c820a5dfa417423807095d91955366a352e298a0d5c66b8a6efccb939136e51a"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.79/macos-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "21ed29d74b52db79956895aaf6c553e4e87c214ffc32aafebbaab8f0a79c1780"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.79/linux-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "87ff2aaa2dd1bec8ab3174d4d8fbfc3f89bdf36df1484b7017f097d1f528504d"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.79/linux-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "46f1385a0e084fe3692496e5d5e0ca88fea8479e76e0cfcc220823d5ac43893a"
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
