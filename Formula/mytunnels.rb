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
  version "0.1.27"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.27/macos-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "84d60a565d5b09b8c5932697e0a8257647d1b9fe829a6c8d524baea5c2a9c4ba"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.27/macos-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "e08dc243e8dbfe28ad84f4c52088fea38b1e1bc13e2b1250df4fbe10b461a4c1"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.27/linux-arm64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "bcd379798a522fa12cc638eb122c780e731e5522f066ba10d442fefe562a4f02"
    end
    on_intel do
      url "https://github.com/KrisPowers/myTunnels/releases/download/v0.1.27/linux-x64.tar.gz", using: GitHubReleaseDownloadStrategy
      sha256 "85e0aac430d9402875d4c2226acc80676368bc2689e6719c9e41c9e1a4e70f28"
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
