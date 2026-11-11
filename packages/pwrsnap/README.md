# PwrSnap

PwrSnap is a desktop screen-capture app for macOS and Windows.

[Download the latest PwrSnap release](https://github.com/pwrdrvr/PwrSnap/releases/latest),
then choose the installer for your platform.

This npm package is a download helper, not a separate command-line edition of
PwrSnap. It only prints the official latest-release URL; it does not download,
install, open, or control the desktop app.

```bash
npx pwrsnap
npx pwrsnap --help
npx pwrsnap --version
```

The version command reports the npm helper package version, not the installed
PwrSnap desktop app version. All other arguments are rejected.
