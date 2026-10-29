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
    openssl rand -base64 32                                # DB_PASSWORD
    cd deploy
    cp .env.production.example .env.production
    nano .env.production                                   # every value above the optional ones
    docker compose --env-file .env.production up -d --build

Caddy fetches the certificate on the first request to the domain. Open
`https://<domain>/register?as=landlord` and sign up: that is the first landlord account.

Keep `.env.production` and both secrets somewhere other than this server as well, such as a
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
rclone `crypt` remote and point `BACKUP_REMOTE` at that, as in `.env.production.example`:

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
container, which has them:
`docker compose --env-file .env.production exec backup sh -c 'apk add -q rclone; rclone copy secure:<file> /backups/'`.)

Both files must be directly in `deploy/backups/`; the script checks that, and that both can be
read, before it stops anything. It then asks you to type RESTORE, stops the app and the backups,
keeps the current database as `tms_previous`, restores the database in one transaction, swaps
the documents in (the current ones are kept in `.restore-prev` inside the storage volume), and
starts both again. If any step fails it puts the database and documents back as they were,
starts the app, and says so. Once all is well, drop the old copies (the script prints the
commands); until `.restore-prev` is removed, nightly backups include it.

## Updating

    git pull
    docker compose --env-file .env.production up -d --build

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
`git pull && docker compose --env-file .env.production up -d` (so the backup container has
`PGPASSWORD`):

    docker compose --env-file .env.production exec db sh -c \
      'sed -i "/^[^#]/s/trust\$/scram-sha-256/" "$PGDATA/pg_hba.conf" && grep -v "^#" "$PGDATA/pg_hba.conf" | grep .'
    docker compose --env-file .env.production exec db psql -U tms_app -d tms -c 'select pg_reload_conf()'

The printed lines should all end in `scram-sha-256`. The app and the backup container both
connect with `DB_PASSWORD`; check both afterwards (`/health`, and `exec backup sh /backup.sh now`).

## Hardening still to do

- **The app is the database superuser.** `tms_app` is the role the Postgres image creates, so it
  can do anything in the cluster. A separate least-privilege role (owning only the `tms` schema
  and the tables its migrations create, with the superuser kept for backups and restores) is
  the next step. It is not done here because it touches every existing server (ownership of
  every table moves), and `restore.sh` restores with `--no-owner` as whoever runs it, so a
  restored database would also need its ownership handed back to the app role. It needs a test
  against a real Postgres before it ships.
- **The backup container reads the whole `.env.production`**, app secrets included, because the
  rclone remote's variables are named after the remote and cannot be listed in the compose file
  ahead of time. Moving `BACKUP_*` and `RCLONE_CONFIG_*` into their own `backup.env` would fix it.
