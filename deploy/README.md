# Running Threshold as a hosted service

One server runs everything: the app, Postgres, Caddy for HTTPS, and nightly backups. This is
the self-hosted build with billing switched on, so landlord sign-up, agent and tenant invites,
two-step sign-in and password reset all work as they do on a laptop.

Tested end to end with this exact compose file: HTTPS through Caddy, migrations on start,
landlord sign-up, a PayFast sandbox checkout, a backup, the restore check and a full restore.

## What you need

- A Linux server with 2 vCPUs, 4 GB RAM and 40 GB disk (Ubuntu 24.04). A South African host
  (Xneelo, Afrihost, Vox) keeps tenants' data in the country, which is the simplest position
  under POPIA. Elsewhere is allowed, but section 72 then needs the host to protect it to the
  same standard, and your privacy notice should say where it is.
- A domain, with an A record for the app address (say `app.threshold.co.za`) pointing at the
  server.
- An SMTP mailbox for sending email (Google Workspace, Microsoft 365, Mailgun, Amazon SES).
- A PayFast merchant account. Use the sandbox until a test payment works end to end.
- An S3-compatible bucket somewhere else for backups (Backblaze B2, Cloudflare R2, AWS S3).

## First start

    # on the server, as a user in the docker group
    git clone https://github.com/Syba-Syba/tms.git && cd tms
    openssl rand -base64 48; openssl rand -base64 48       # AUTH_SECRET and STORAGE_SECRET
    openssl rand -base64 32                                # three times: DB_PASSWORD,
                                                           # DB_SERVER_PASSWORD, DB_BACKUP_PASSWORD
    cd deploy
    cp .env.production.example .env.production
    nano .env.production                                   # every value above the optional ones
    cp backup.env.example backup.env
    nano backup.env                                        # the bucket for copies off the server
    docker compose --env-file .env.production up -d --build

Caddy fetches the certificate on the first request to the domain. Open
`https://<domain>/register?as=landlord` and sign up: that is the first landlord account.

Keep `.env.production`, `backup.env` and both secrets somewhere other than this server as well, such as a
password manager. `STORAGE_SECRET` is the key for ID numbers and two-step secrets: a restored
database is unreadable without it.

## Every day

- **Backups** run at 02:30 Johannesburg time: the database and the uploaded documents, kept 14
  days (`BACKUP_KEEP_DAYS`) in `deploy/backups/`, and copied to `BACKUP_REMOTE` when it is set;
  copies there older than `BACKUP_KEEP_DAYS` are deleted too. Each dump is checked as readable
  before it counts. A backup counts (and `last-ok` is written) only when every step worked,
  including the copy off the server: if that copy fails, the local files are kept but the log
  says `FAILED: OFFSITE COPY` and `/health` turns red after 36 hours. See it with
  `docker compose logs backup`.
- **Health**: `https://<domain>/health` answers 200 when the database is up, every daily job ran
  in the last two days, and the last backup is under 36 hours old; otherwise 503 and why. Point
  an uptime monitor at it (UptimeRobot and Better Stack are free at this size) with alerts to
  your phone.
- **Alerts**: unhandled errors and failed jobs are emailed to `ALERT_EMAIL`, at most once an
  hour per kind of failure.
- **Logs**: `docker compose logs -f app` (one JSON line per request or job).

## Encrypting the copies off the server

The backups are tenants' personal information (ID numbers, leases, signed documents), so under
POPIA the copy in someone else's bucket should be unreadable to them. Wrap the bucket in an
rclone `crypt` remote and point `BACKUP_REMOTE` at that, in `backup.env` as in `backup.env.example`:

    BACKUP_REMOTE=secure:
    RCLONE_CONFIG_OFFSITE_TYPE=s3                    # the bucket itself
    RCLONE_CONFIG_OFFSITE_PROVIDER=Other
    RCLONE_CONFIG_OFFSITE_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=...
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=...
    RCLONE_CONFIG_SECURE_TYPE=crypt                  # encrypts into it
    RCLONE_CONFIG_SECURE_REMOTE=offsite:threshold-backups
    RCLONE_CONFIG_SECURE_PASSWORD=<obscured>
    RCLONE_CONFIG_SECURE_PASSWORD2=<obscured>

Make each password with `openssl rand -base64 32`, store the plain value in your password
manager, and put `docker run --rm rclone/rclone obscure '<plain value>'` in the file. Lose them
and the copies off the server are noise. File names are encrypted too, so list and fetch through
`secure:`, never `offsite:`. If you switch an existing setup to `secure:`, the old unencrypted
copies in the bucket are not pruned by it: delete them by hand once a night has run.

## Every month: prove the backups work

    docker compose --env-file .env.production exec backup sh /backup.sh check

This restores the newest dump into a scratch database, compares row counts with the live one,
and drops it. A backup that has never been restored is a hope, not a backup.

## Checking the data

    docker compose --env-file .env.production exec app node --import tsx scripts/db-check.mjs

Reads the database and reports anything that breaks the app's rules: a unit marked occupied with
no lease, an invoice marked paid that is short, a payment against another lease's invoice, a
landlord with no owner, a credit check with no consent, a document the database points at that is
missing from storage. It changes nothing. Run it monthly with the backup check, after a restore,
and before and after any manual SQL. It exits with an error when it finds one, so it can gate a
script.

## Putting a backup back

    rclone copy secure:db-2026-10-28T0030Z.dump backups/            # if needed
    rclone copy secure:storage-2026-10-28T0030Z.tar.gz backups/
    ./restore.sh backups/db-2026-10-28T0030Z.dump backups/storage-2026-10-28T0030Z.tar.gz

(`rclone` on the server needs the same `RCLONE_CONFIG_*` values; or run it in the backup
container, which reads them from `backup.env`:
`docker compose --env-file .env.production exec backup sh -c 'apk add -q rclone; rclone copy secure:<file> /backups/'`.)

Both files must be directly in `deploy/backups/`; the script checks that, and that both can be
read, before it stops anything. It then asks you to type RESTORE, stops the app and the backups,
keeps the current database as `tms_previous`, restores the database in one transaction, swaps
the documents in (the current ones are kept in `.restore-prev` inside the storage volume), and
starts both again. The database steps run as the owner, `tms_app`, in a one-off container of
the database image. If any step fails it puts the database and documents back as they were,
starts the app, and says so. Once all is well, drop the old copies (the script prints the
commands); until `.restore-prev` is removed, nightly backups include it.

## Rehearsing a restore

    sh deploy/drill.sh

Run it on a staging server (or any machine with Docker) before you first rely on `restore.sh`,
and after changing anything in this folder. It builds the app and starts its own copy of the
database, the app and the backups, under a separate project name in a temporary folder, so a
real install on the same machine is not touched and no ports are opened. It checks the
database roles, signs a landlord up, backs up, runs the restore check, damages the data,
restores, checks the data, documents and app, then runs a restore that fails part-way and
checks everything is put back. It removes everything it made and ends with `DRILL PASSED` or
`DRILL FAILED`. It takes about five minutes, most of it the build. CI runs it on every change
to `deploy/`.

## Updating

    git pull
    docker compose --env-file .env.production up -d --build

**Updating a server set up before the database roles** (the app used to run as `tms_app`, the
database owner): `docker compose` refuses to start until two lines are added. Before the
`up` above:

    cd deploy
    printf 'DB_SERVER_PASSWORD=%s\nDB_BACKUP_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env.production
    # if .env.production has BACKUP_* or RCLONE_CONFIG_* lines, move them to backup.env:
    grep -E '^(BACKUP_|RCLONE_CONFIG_)' .env.production > backup.env
    sed -i -E '/^(BACKUP_|RCLONE_CONFIG_)/d' .env.production

The app creates both roles on its next start. Until the remote settings are moved, the backup
log says `FAILED: BACKUP_REMOTE is set in .env.production` and no backup counts, so `/health`
goes red rather than backups quietly staying on this server. Afterwards run
`docker compose --env-file .env.production exec backup sh /backup.sh now` and check it says
`done`.

Migrations run when the app starts. Each one runs once and is checked by checksum; the app does
not start on a database it cannot bring up to date. Take `sh /backup.sh now` first if a
release adds migrations.

## PayFast

- The notify URL is `https://<domain>/billing/notify`. PayFast reaches it from the internet;
  nothing to configure on PayFast's side beyond the passphrase in their dashboard matching
  `PAYFAST_PASSPHRASE`.
- Sandbox first (`PAYFAST_SANDBOX=true`, merchant 10000100): a first payment, a plan change and
  a cancellation, and check the Plan screen after each. Then set your live merchant details and
  `PAYFAST_SANDBOX=false`.

## Database passwords

Postgres checks the password on its socket as well (`scram-sha-256`), so being able to reach
the socket is not enough. That is set when the database is first created
(`POSTGRES_INITDB_ARGS`); **a server set up before this change still trusts the socket**, because
an existing database keeps its `pg_hba.conf`. To switch one over, after
`git pull && docker compose --env-file .env.production up -d` (so the new roles exist):

    docker compose --env-file .env.production exec db sh -c \
      'sed -i "/^[^#]/s/trust\$/scram-sha-256/" "$PGDATA/pg_hba.conf" && grep -v "^#" "$PGDATA/pg_hba.conf" | grep .'
    docker compose --env-file .env.production exec db psql -U tms_app -d tms -c 'select pg_reload_conf()'

The printed lines should all end in `scram-sha-256`. The app connects with its role's password
and the backups with theirs; check both afterwards (`/health`, and
`exec backup sh /backup.sh now`). Until this is done the app log warns on every start.

## Who can do what in the database

Three roles, set up by the app each time it starts (`tms/api/scripts/db-roles.mjs`):

| Role | Used by | Can |
| --- | --- | --- |
| `tms_app` | migrations on start, `restore.sh` | everything: it owns the database (`DB_PASSWORD`) |
| `tms_server` | the running app | read and write rows; not create, change or drop anything, nor edit the migration log (`DB_SERVER_PASSWORD`) |
| `tms_backup` | nightly backups and the restore check | read everything, and create the scratch database the check uses; not write (`DB_BACKUP_PASSWORD`) |

The app container runs its migrations as `tms_app`, then starts the server as `tms_server`
with the owner's password removed from its environment. The backup container reads only
`backup.env` and its own password, never `.env.production`. So a fault in the app that let
someone run SQL could not drop a table, and a leak from the backup container gives away no
app secrets.

The owner's password is still in the app container's settings, because migrations need it at
start. Running migrations as a separate one-off step would remove it; at this size the gain
is small.
