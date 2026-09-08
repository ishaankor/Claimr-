<p align="center">
  <img src="assets/icon.png" width="140" alt="Claimr Logo" />
</p>

<h1 align="center">Claimr</h1>

<p align="center">
  <b>The modern, multi-store desktop app that automatically claims free games from Epic Games Store and GOG.com.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/Release-v1.0.0-purple?style=flat-square" alt="Release" />
</p>

---

## 📥 Download & Install

Claimr is a standalone desktop application. No programming knowledge, terminal commands, or Node.js required.

| Platform | Download | Instructions |
| :--- | :--- | :--- |
| **macOS** (Apple Silicon & Intel) | [**Download Claimr.dmg**](https://github.com/ishaankoradia/claimr/releases/latest) | Open the `.dmg` and drag **Claimr** to your **Applications** folder. |
| **Windows** | [**Download Claimr-Setup.exe**](https://github.com/ishaankoradia/claimr/releases/latest) | Run the installer and launch Claimr from the Start Menu. |
| **Linux** | [**Download Claimr.AppImage**](https://github.com/ishaankoradia/claimr/releases/latest) | Make executable (`chmod +x`) and run. |

> **macOS Note**: Because Claimr is a community open-source app distributed outside the Mac App Store, macOS Gatekeeper may show a warning on first launch. If prompted, right-click **Claimr.app** in Applications and choose **Open**, or run:
> ```bash
> xattr -cr /Applications/Claimr.app
> ```

---

## ✨ Features

* **🎮 1-Click Game Claiming**: Claim all active promotions across both Epic Games and GOG with a single click, or click any individual game card to run the automator specifically for that game.
* **👥 Multi-Account Support**: Add and switch between multiple Epic Games and GOG accounts directly from the dashboard.
* **🔄 Real Store Library Sync**: Checks your actual store library in real time. Games you already own outside Claimr are accurately recognized as **"In Library"**.
* **⚡ Silent Cross-Platform Auto-Claim**: Turn on the built-in **Auto-Claim** switch in the top toolbar. Claimr automatically runs silent claims twice daily (11:15 AM & 8:15 PM) across macOS, Windows, and Linux while living quietly in your system tray or menu bar.
* **⏳ Drop Countdown Timer**: Real-time countdown ticking down to Epic's next weekly drop (every Thursday at 11:00 AM EST).
* **🖥️ System Tray / Menu Bar**: Minimizes to the macOS menu bar or Windows/Linux notification area so you can check giveaway status or trigger instant claims at any time.
* **📜 Claim History**: Complete audit log with timestamps of every game claimed.

---

## 🚀 How to Use

1. **Open Claimr**: Launch the application from your Applications folder.
2. **Connect Accounts**:
   * Click **Connect** next to **Epic Games** to log into your Epic account.
   * Click **Connect** next to **GOG.com** to log into your GOG account.
   * *(Optional)* Click **Swap Account ▾ ➔ Add Another Account** to link multiple accounts.
3. **Claim Freebies**:
   * Click **Claim Free Games** to claim all active giveaways at once.
   * Or click directly on any game card in the **Available Now** grid to claim that specific title.
4. **Enable Background Auto-Claim**:
   * Flip the **Auto-Claim** toggle switch in the top-right toolbar.
   * Claimr will automatically monitor and claim all future weekly drops silently in the background!

---

## 🔒 Privacy & Security

* **100% Local**: Claimr runs entirely on your machine. Your login sessions and cookies are stored exclusively in your local application directory and are **never** sent to any external server.
* **Open Source**: Full source code is transparent and auditable under the MIT License.

---

<details>
<summary><b>🛠️ Developer & Contributor Instructions</b></summary>

<br />

If you are a developer and wish to build or contribute to Claimr from source:

```bash
# Clone the repository
git clone https://github.com/ishaankoradia/claimr.git
cd claimr

# Install dependencies
npm install

# Run in development mode
npm run app

# Package standalone installers
npm run dist:mac    # Build macOS .dmg and .zip
npm run dist:win    # Build Windows installer
npm run dist:linux  # Build Linux AppImage
```

</details>

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
