cask "codex-usage-desktop" do
  arch arm: "arm64", intel: "x64"

  version "4.1.0"
  sha256 arm:   "abd5cef4406834dfa5a9143377215b8d932a73c742fa715e894af9cc0413fc39",
         intel: "60f4609a3f1f7c8703d12ed655168883e3385dff913790de6e6dec2a06617353"

  url "https://github.com/itvincent-git/codex-usage-desktop/releases/download/app-v#{version}/codex-usage-desktop-macos-#{arch}.dmg"
  name "Codex Usage Desktop"
  desc "Local-first dashboard for Codex CLI token usage and cost estimates"
  homepage "https://github.com/itvincent-git/codex-usage-desktop"

  depends_on :macos

  app "Codex Usage Desktop.app"

  zap trash: [
    "~/Library/Application Support/com.ccusage.codex.desktop",
    "~/Library/Caches/com.ccusage.codex.desktop",
    "~/Library/Logs/com.ccusage.codex.desktop",
    "~/Library/Preferences/com.ccusage.codex.desktop.plist",
    "~/Library/Saved Application State/com.ccusage.codex.desktop.savedState",
  ]
end
