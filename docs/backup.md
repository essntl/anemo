# Backup and restore

A backup has three parts, and the scripts take all of them while the app keeps running:

| File | Contents |
|---|---|
| `database.dump` | Everything structured: conversations, settings, tasks, calendar, memory, automations, run history. |
| `data.tar.gz` | Uploads, saved tool outputs and the undo copies of files agents changed. |
| `workspace.tar.gz` | Your workspace: files and documents. |
| `VERSION` | The Anemo version the backup was made with. |

**Not included: your `.env` file.** Keep a copy of it somewhere safe, most of all
`APP_SECRET_KEY`. Saved API keys, webhooks and MCP secrets are encrypted with that
key. A restore onto an install with a different key works, but those secrets
cannot be read and have to be entered again.

## Make a backup

From the folder with `docker-compose.yml`:

```bash
sh scripts/backup.sh                # into ./backups/anemo-<date>-<time>/
sh scripts/backup.sh /mnt/nas/anemo # or somewhere else
```

The script stops with an error if a part comes out empty (for example because a
container is not running); do not keep such a folder.

To run it every night, add a line to the host's crontab:

```cron
30 3 * * * cd /opt/anemo && sh scripts/backup.sh /mnt/nas/anemo >> /var/log/anemo-backup.log 2>&1
```

Old backups are not removed for you. Each one is a full copy.

### Installs without a compose file in reach (ZimaOS / CasaOS)

Tell the scripts the project name instead. ZimaOS picks the name itself; find it with
`docker compose ls` (it looks like `compose-4d75…` or `anemo`):

```bash
COMPOSE="docker compose -p <name>" sh backup.sh /DATA/Backups
```

## Restore

Use an install of the same or a newer version that has been started at least once,
with the `APP_SECRET_KEY` of the install the backup came from.

```bash
sh scripts/restore.sh backups/anemo-20261001-033000
```

It asks you to type `restore`, then:

1. stops the app and the worker,
2. replaces the database with the one from the backup,
3. unpacks the data and workspace files (files of the same name are overwritten;
   files that exist only in the install are left in place),
4. starts everything again, which also upgrades the database if the install is newer.

Set `RESTORE_YES=1` to skip the question in a script.

## Moving to another machine

1. On the old machine: `sh scripts/backup.sh`, and copy the backup folder and `.env`.
2. On the new machine: install Anemo with that `.env`, run `docker compose up -d` once.
3. `sh scripts/restore.sh <backup-folder>`.

## Check your backups

A backup you never restored is a guess. The scripts were tested by restoring into a
throwaway copy of the app; you can do the same on any machine with Docker: install
a second copy in another folder with another `APP_PORT`, restore into it, and look
around.
