# Backup and restore

How a customer stack's data survives losing the machine it runs on: what is
safe without doing anything, what the nightly backup does, how an
administrator says where backups go, and how to get everything back onto a new
host. Tooling: [`deploy/backup.mjs`](../deploy/backup.mjs) (`backup.sh` is its
cron entry point). Tests: `deploy/test/backup-offsite.test.ts`,
`deploy/test/backup.test.ts`, and the per-package `backup-restore` suites.

## What survives what

| Event | Data | Why |
| --- | --- | --- |
| Shutdown, reboot, `docker compose down`/`up` | **safe** | Every service and module writes to a SQLite file on its own Docker volume (`/data/data.db`). Nothing lives only in memory; containers restart by themselves (`restart: unless-stopped`). |
| Power cut or crash mid-operation | **safe up to the last completed save** | SQLite in WAL mode commits atomically: a transaction is either fully on disk or not at all, and the database is never left half-written. The one request in flight at that instant may be lost and has to be repeated. |
| A bad update, an operator mistake | **last snapshot** | The last `BACKUP_KEEP_LOCAL` snapshots stay on each volume, so you can roll back without fetching anything. |
| The disk or the whole machine dies, theft, fire | **last archive that left the host** | Only what is on a target in `BACKUP_TARGETS` survives this. **Without a target, nothing does.** |
| Ransomware on the host | **depends on the target** | Something with root on the host can reach every target the host can write to. See [Making a target tamper-proof](#making-a-target-tamper-proof). |

The recovery point is the last run: with the nightly default, up to one
working day. The job is online-consistent and can run during business hours,
so a customer who cannot lose a day runs it more often (e.g. `0 */4 * * *`).

## What a run does

1. Every running container that ships `scripts/backup.mjs` snapshots its
   database (better-sqlite3's online backup API — never a file copy of a live
   database) and its files folders (MOD-01 documents, MOD-08 exports, MOD-09
   storage) into `/data/backups/run-<stamp>/` on its own volume. The containers
   are asked, not listed, so a stack cannot outgrow the script.
2. Older `run-*` folders beyond `BACKUP_KEEP_LOCAL` are deleted.
3. The snapshots, plus the stack's `.env`, `docker-compose.yml`, `Caddyfile`,
   `manifest.json` and monitoring config, are packed into **one** archive:
   `0815-<customer>-<YYYYMMDDTHHMMSSZ>.bak`. The `.env` is included because a
   restored database is useless without its secrets (`SESSION_SECRET`s,
   PS-12's `EBICS_KEY_SECRET`).
4. The archive is encrypted — AES-256-GCM, key from scrypt over
   `BACKUP_PASSPHRASE`, the header authenticated too — and copied to every
   target. Each target then applies retention.
5. The outcome goes to `backup-status.json`; a failure is POSTed to
   `BACKUP_ALERT_URL`, a success pings `BACKUP_HEARTBEAT_URL`.

The run exits non-zero unless every container was snapshotted **and** every
target holds the archive. Half a backup still gets uploaded, but it is
reported as the failure it is.

`backup.env` is never put into an archive: it holds the passphrase that opens
the archive and the credentials of the targets.

## Configuring where backups go

Everything is in `backup.env`, in the stack directory beside `.env`.
`provision.mjs` writes it with a fresh passphrase and no target; a
re-provision never overwrites it.

```sh
node <repo>/deploy/backup.mjs setup /opt/customers/xy   # asks, writes backup.env, tests it
node <repo>/deploy/backup.mjs check /opt/customers/xy   # re-test at any time; --test-alert sends one
```

`setup` asks which kind of target, writes the file, and runs `check`; run it
again to add a second target. Editing `backup.env` by hand is just as good —
every setting is explained in the file. An unknown key (a typo), a short
passphrase or a retention value that is not a number stops the run with a
message instead of being ignored.

### The three kinds of target

```sh
BACKUP_TARGETS=/mnt/nas/0815-backups sftp://backup@nas.local/backups/0815 s3://my-bucket/blaustern
```

**A mounted folder** (`/mnt/nas/0815-backups`): a NAS share over SMB or NFS,
or a USB disk. Mount it on the host, e.g. in `/etc/fstab`:

```
# SMB (Synology, QNAP, Windows): credentials file is chmod 600, holds username= / password=
//nas.local/backup  /mnt/nas  cifs  credentials=/root/.nas-credentials,uid=0,gid=0,_netdev,nofail  0 0
# NFS
nas.local:/volume1/backup  /mnt/nas  nfs  _netdev,nofail  0 0
```

Create the folder on the share yourself. The tool will not create it: with
the mount missing, `/mnt/nas` is an empty folder on the system disk, and
creating a folder there would quietly put every backup on the disk it is meant
to protect against. For the same reason a folder on the same disk as the stack
is refused unless `BACKUP_ALLOW_SAME_DISK=yes`.

**SFTP** (`sftp://user@host[:port]/path`): a NAS or a server reachable over
SSH. Only SFTP is used, never a shell, so a transfer-only account is enough.
It runs in batch mode — no password prompts — so log in with a key:

```sh
ssh-keygen -t ed25519 -f /root/.ssh/0815-backup -N ''          # once, on the host
# install /root/.ssh/0815-backup.pub for the backup account on the NAS
# (Synology: enable SSH + "user home"; put it in ~backup/.ssh/authorized_keys)
ssh-keyscan nas.local >> /root/.ssh/known_hosts                # then compare the fingerprint with the NAS
echo 'BACKUP_SFTP_IDENTITY=/root/.ssh/0815-backup' >> backup.env
```

An unknown host key is refused rather than accepted silently; `check` says
which command adds it.

**S3-compatible storage** (`s3://bucket/prefix`): AWS, Hetzner Object
Storage, IONOS, Wasabi, Backblaze B2, or MinIO on your own NAS. Set
`BACKUP_S3_ENDPOINT` (empty means AWS), `BACKUP_S3_REGION`,
`BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY`. Give the key
access to that one bucket only. A single archive can be at most 5 GiB here (one
S3 PUT); the run refuses larger ones up front rather than failing half-way.

**Recommendation — two targets, one of them elsewhere** (3-2-1: three copies,
two media, one off-site): the NAS in the office for fast restores, plus a
bucket or server in another building for fire, theft and flooding.

### The passphrase

`BACKUP_PASSPHRASE` (at least 16 characters; `provision.mjs` and `setup`
generate 48/32 random characters) encrypts every archive. **Store a copy
outside this host now** — a password manager, a sealed envelope in the safe.
It is the one thing a restore cannot do without: an archive without it cannot
be opened, by anyone. You can keep it out of `backup.env` with
`BACKUP_PASSPHRASE_FILE=/root/.0815-backup-passphrase`.

Changing it is safe for new archives; the old ones still need the old one.
Keep both until the old archives have aged out of retention.

### Retention

On each target the archives kept are, counting back from the newest: the
newest of each of the last `BACKUP_KEEP_DAILY` days (default 7), of the last
`BACKUP_KEEP_WEEKLY` ISO weeks (4) and of the last `BACKUP_KEEP_MONTHLY`
months (12). Days are counted over the archives that exist, so a host that
was off for two weeks keeps its last good dailies. The newest archive is
never deleted, and nothing on a target that is not named like this stack's
archives is ever touched — a NAS share can be shared with other things.

### Being told

- `BACKUP_ALERT_URL` — a JSON POST when a run fails (`{ text, message, stack,
  host, status, errors, at }`), which Slack/Mattermost incoming webhooks and
  n8n understand. A failed `verify` exits non-zero and logs, but sends nothing.
- **The administrators' phones** — when the stack runs PS-03, a failed run is
  also sent as an ops event to the recipients set under Account →
  Administration (push, or mail when no device takes it). Best-effort: PS-03
  being down is a likely reason for the failure in the first place.
- `BACKUP_HEARTBEAT_URL` — fetched after every success. Point it at a
  healthchecks.io check or an Uptime Kuma push monitor with a 26-hour period.
  This is the only way to hear about a backup that **never ran**: the host was
  off, cron was removed, the disk was full before the job started.

## Scheduling

```
# crontab -e on the host
0 2 * * *  /opt/platform/deploy/backup.sh /opt/customers/xy >> /opt/customers/xy/backup.log 2>&1
0 5 * * 0  node /opt/platform/deploy/backup.mjs verify /opt/customers/xy >> /opt/customers/xy/backup.log 2>&1
```

`verify` is the weekly restore drill: on every target it fetches the newest
archive, decrypts it, checks every database in it is really a SQLite file and
that `.env` is there, and fails when the newest is more than 36 hours old.

Host requirements: Docker with the compose plugin, Node 22, `tar`, and the
`sftp` client for sftp:// targets. Nothing is installed from npm. The working
folder (`.backup-work` in the stack directory, or `BACKUP_WORK_DIR`) needs
room for about twice the size of all data.

## Restoring

```sh
node <repo>/deploy/backup.mjs list    /opt/customers/xy
node <repo>/deploy/backup.mjs restore /opt/customers/xy [--archive NAME] [--from TARGET]
node <repo>/deploy/backup.mjs restore /opt/customers/xy --archive NAME --apply --yes
```

Without `--apply`, `restore` only fetches, decrypts and unpacks the archive
into `<stack>/restore-<stamp>/` and changes nothing that is running. With
`--apply --yes` it then stops the stack, writes every service's snapshot into
its volume (removing stale `-wal`/`-shm` files first — a stale WAL next to a
restored database would be replayed into it), puts the files folders back,
and starts the stack; pending schema migrations apply on boot.

### After a bad update (same host)

1. `restore <stack> --archive <the one from before the update>` and look at
   what it unpacked.
2. `restore <stack> --archive <same> --apply --yes`.
3. Check `/api/health` of the modules, then delete the `restore-*` folder.

Your current `.env` and compose file are kept; the archived copies are in
`restore-<stamp>/stack/` if you need to compare.

For an even quicker rollback without any target, the last snapshots are still
on each volume under `/data/backups/run-*`: stop the container, copy the
`backup-*.db` over `/data/data.db` (deleting `data.db-wal` and `data.db-shm`),
start it.

### After losing the host

1. New machine: install Docker, Node 22 and `tar`; clone this repository to the
   same path as before (the compose file's build contexts point there — if it
   has to be elsewhere, fix the `context:` lines after step 3).
2. Recreate the stack folder with just `backup.env`: the target and the
   passphrase from the password manager (plus the target's credentials). Put
   `manifest.json` from any copy there too, or name the folder after the
   customer, so archive names match. Mount the NAS / install the SFTP key as
   before.
3. `node deploy/backup.mjs restore <stack>` — puts `.env`, `docker-compose.yml`,
   `Caddyfile`, `manifest.json` back and unpacks the data.
4. `node deploy/backup.mjs restore <stack> --apply --yes` — builds/creates the
   containers and volumes, writes the data in, starts everything.
5. Point DNS at the new host; Caddy fetches new certificates by itself.
6. Run `check` and `verify`, and put the cron lines back.

`deploy/test/backup-offsite.test.ts` plays exactly this out: back up, delete
every volume, restore into an empty folder, compare the data.

## Making a target tamper-proof

Anything with root on the host can do what the backup job can — including
deleting archives on a writable target. Against ransomware, make at least one
target keep history the host cannot erase:

- **NAS snapshots**: Synology/QNAP Btrfs snapshots of the backup share
  (immutable snapshots where the NAS supports them), taken by the NAS itself.
- **S3 with versioning + Object Lock** (or a provider's immutability
  setting): a delete from the host only adds a delete marker; the locked
  versions stay for the lock period. Retention still runs and keeps the
  bucket tidy; the lock is what saves you.
- **A pull instead of a push**: a second machine fetching from the NAS with
  credentials the host never sees.

## Out of scope

- **High availability.** One host, SQLite, single writer. A dead host means
  downtime until the restore above is done; there is no hot standby.
- **Continuous backup.** Recovery point = the last run. WAL streaming (e.g.
  Litestream) would close that, at the cost of a new dependency.
- **Multipart S3 uploads.** Archives above 5 GiB need a mounted-folder or
  SFTP target.
- **Push to anything but PS-03** (ntfy, Teams cards). Failures reach a JSON
  webhook and, when the stack runs PS-03, the ops recipients' phones; anything
  else is wired up on the receiving side.
- **Backing up `backup.env`.** It cannot be inside the archives it opens; it
  belongs in the password manager.
