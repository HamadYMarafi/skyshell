# age setup — term-box backup encryption

Asymmetric encryption: the box only ever holds a **public** key (it can encrypt,
it cannot decrypt). The **private** key lives on your Mac (or wherever you want
to be able to restore from), never on the box. This is what makes "R2 only ever
holds encrypted blobs" actually true even if the box itself is compromised.

## 1. Install `age` on your Mac

This Mac has no Homebrew, so install the static binary the same way `ffmpeg`/
`shellcheck` are installed here (`~/.local/bin`):

```bash
mkdir -p ~/.local/bin && cd /tmp
curl -sL https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-darwin-arm64.tar.gz -o age.tar.gz
tar xf age.tar.gz
cp age/age age/age-keygen ~/.local/bin/
chmod +x ~/.local/bin/age ~/.local/bin/age-keygen
age --version   # sanity check
```

(Verified live 2026-07-15: `v1.3.1` is current and this exact URL resolves.
Check the [age releases page](https://github.com/FiloSottile/age/releases) for
a newer version if this has moved on since.)

## 2. Generate the keypair — ON YOUR MAC, never on the box

```bash
mkdir -p ~/.config/age
age-keygen -o ~/.config/age/term-backup.key
```

This prints the **public key** once to stdout, e.g.:

```
Public key: age1REPLACE_WITH_YOUR_PUBLIC_KEY
```

`~/.config/age/term-backup.key` now contains the private key (age-keygen sets
it `0600` automatically). Two things to do right now, before you forget:

1. **Copy the private key into your password manager** (open the file, copy
   the `AGE-SECRET-KEY-1...` line, paste it into a new secure note — the whole
   point of this exercise is "box dies, backups are still recoverable," and
   that only holds if the key survives independently of this one Mac).
2. **Copy the public key** (`age1...` line) — you need it for step 3.

If you ever need the public key again from the private key file alone:

```bash
age-keygen -y ~/.config/age/term-backup.key
```

## 3. Put ONLY the public key on the box

Edit `~/term-ui/term-backup.sh` on the box (after applying the new version —
see `CHANGES.md`) and replace the placeholder:

```bash
AGE_RECIPIENT="age1REPLACE_WITH_YOUR_PUBLIC_KEY"
```

with your real public key, e.g.:

```bash
AGE_RECIPIENT="age1REPLACE_WITH_YOUR_PUBLIC_KEY"
```

That's it — the box never sees, needs, or stores the private key. It can only
encrypt *to* that public key; decrypting requires the file from step 2.

## 4. Install `age` on the box

```bash
sudo apt-get update && sudo apt-get install -y age
command -v age && age --version
```

(Box is `arm64` Ubuntu 24.04 — the `age` package in the standard 24.04 repo
covers it; `apt-cache policy age` on the box shows `1.1.1-1ubuntu0.24.04.3` as
the candidate at time of writing.)

Until both step 3 (real `AGE_RECIPIENT`) and step 4 (`age` installed) are done,
the new `term-backup.sh` **skips the R2 push entirely** and only writes the
local plaintext backup — it will never fall back to pushing plaintext to R2.
Check the backup's own log line (`journalctl -u term-backup` or the systemd
timer's last run) for a `WARN: age not installed` / `WARN: AGE_RECIPIENT not
configured` line if R2 stops receiving new objects after you apply the script.

## 5. Set up `restore-verify.sh` (weekly, off-box)

`restore-verify.sh` needs `age` (already installed above) plus `rclone`
configured with an R2 remote on your Mac:

```bash
# rclone — also no Homebrew, static binary (URL verified live 2026-07-15):
curl -sL https://downloads.rclone.org/rclone-current-osx-arm64.zip -o /tmp/rclone.zip
cd /tmp && unzip -q rclone.zip && cp rclone-*-osx-arm64/rclone ~/.local/bin/ && chmod +x ~/.local/bin/rclone
rclone version

# configure a remote named "r2" (matches restore-verify.sh's default
# R2_REMOTE=r2:backups/term-box). Use a READ-ONLY R2 API token if you create
# a fresh one for this — the verify runner only ever needs to read, never write.
rclone config
```

Then either run `restore-verify.sh` by hand weekly, or wire it into a Mac
`launchd`/`cron` job (macOS has no systemd, so the included
`term-restore-verify.service`/`.timer` are templates for a future dedicated
Linux verify-host, not for this Mac or the term-ui box — see the comment
block at the top of `term-restore-verify.service` and `CHANGES.md`).
