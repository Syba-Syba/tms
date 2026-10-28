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
  days in `deploy/backups/`, and copied to `BACKUP_REMOTE` when it is set. Each dump is checked
  as readable before it counts.
- **Health**: `https://<domain>/health` answers 200 when the database is up, every daily job ran
  in the last two days, and the last backup is under 36 hours old; otherwise 503 and why. Point
  an uptime monitor at it (UptimeRobot and Better Stack are free at this size) with alerts to
  your phone.
- **Alerts**: unhandled errors and failed jobs are emailed to `ALERT_EMAIL`, at most once an
  hour per kind of failure.
- **Logs**: `docker compose logs -f app` (one JSON line per request or job).

## Every month: prove the backups work

    docker compose --env-file .env.production exec backup sh /backup.sh check

This restores the newest dump into a scratch database, compares row counts with the live one,
and drops it. A backup that has never been restored is a hope, not a backup.

## Putting a backup back

    rclone copy offsite:threshold-backups/db-2026-10-28T0030Z.dump backups/       # if needed
    ./restore.sh backups/db-2026-10-28T0030Z.dump backups/storage-2026-10-28T0030Z.tar.gz

It asks you to type RESTORE, stops the app, keeps the current database as `tms_previous`,
restores both the database and the documents from the same night, and starts the app again.

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
