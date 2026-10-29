# Tenant management system

Phase 1: onboarding and lease signing. One landlord, own units.
Android APK and web PWA from one codebase.

## Repo

    db/migrations   Postgres schema
    api/            Lambda handlers, TypeScript, Serverless Framework
    app/            React PWA wrapped with Capacitor for Android

## AWS pieces

| Piece | Service | Note |
| --- | --- | --- |
| Auth | Cognito user pool, groups `tenant` and `landlord` | JWT authorizer on HTTP API |
| API | API Gateway HTTP API + Lambda nodejs20 | region af-south-1 |
| Database | RDS Postgres db.t4g.micro behind RDS Proxy | Proxy stops Lambda exhausting connections |
| Documents | S3 with KMS encryption, presigned PUT | files never pass through Lambda |
| ID numbers | KMS envelope encryption, last 4 digits in clear | PoPIA |
| Email and SMS | SES and SNS | lease sent, PIN for signing |

Estimated running cost at this size: 15 to 25 USD a month.

## Running it as the hosted service

`deploy/` runs the self-hosted build on one server with Docker: the app, Postgres (through its
socket, no open port), Caddy for HTTPS, and nightly backups with a restore check and a restore
script. `deploy/README.md` is the runbook. `GET /health` is public for an uptime monitor: 200
when the database answers, the daily jobs ran in the last two days and the last backup is under
36 hours old. Unhandled errors and failed jobs are emailed to `ALERT_EMAIL`, at most once an hour
per kind, sent directly so they still go out when the database is what broke.

## Running it for real without AWS

There are three modes, and `APP_MODE` picks the middle one:

| Mode | Identity | Database | Documents | Who it is for |
| --- | --- | --- | --- | --- |
| `development` | faked from an `x-dev-sub` header | PGlite | on disk | a laptop |
| `self-hosted` | email and password, checked | PGlite or Postgres | on disk | real users, your machine |
| `aws` | Cognito, checked by API Gateway | RDS | S3 + KMS | the deployed stage |

The difference that matters is identity. `npm run dev` runs `src/local.ts`, which falls back to
whatever `x-dev-sub` claims when there is no token, so anyone who can reach the port is the
landlord. That is why it refuses to start outside development. Self-hosted mode runs
`src/server.ts` instead, which has no fallback at all: no token is 401, on every route except
the ones that issue tokens or reset a password.

    cd api
    cp .env.selfhosted.example .env.selfhosted
    npm run secrets:generate          # paste both values into .env.selfhosted
    npm run migrate:selfhosted        # seed files are skipped, as always

    BOOTSTRAP_PASSWORD='...' npm run bootstrap -- \
      --email you@example.co.za --name "Mokoena Properties"

    cd .. && npm run selfhost:build   # builds the toolbox and the web app
    npm run selfhost:start            # http://127.0.0.1:3001

One process serves the API and the web app on one port, so the browser makes no cross-origin
call and there is no CORS to configure. `VITE_API_URL=/` is what `selfhost:build` sets to get
that; a build with it unset now fails rather than baking in `http://localhost:3001`.

`npm run bootstrap` exists because a freshly migrated database has no landlord row — the only
insert into `landlord` is in the development seed, which the migration runner skips — so
without it every landlord route answers 403.

### Background jobs

On AWS, EventBridge runs five jobs. Self-hosted, the server runs them itself (`RUN_JOBS=true`,
the default). Times are Johannesburg time:

| Job | When |
| --- | --- |
| `notifications-dispatch` | every 5 minutes |
| `leases-activate` | 03:10 daily |
| `notifications-sweep` | 05:00 daily |
| `interest-run` | 05:30 on the 1st |
| `invoices-run` | 06:00 daily (this month; next month too from the 25th) |

Each daily job also runs once about five seconds after startup, so a machine that was off at
06:00 catches up. `interest-run` catches up only on the 1st, so a restart mid-month cannot post
interest early. A catch-up before a job's own time still lets it run at that time. A job that
fails is retried after 15 minutes, then 30, 60, and every 2 hours, until it succeeds that day;
an `interest-run` that fails all day on the 1st needs `npm run jobs -- interest-run` by hand.
Each finished daily job writes a `job.finished` row to `audit_log`. All of them are safe to run
twice. To drive them from cron instead, set `RUN_JOBS=false` and call one by name:

    npm run jobs -- invoices-run

Cron mode needs Postgres. PGlite is one process against one folder and the server holds it, so
on `DB_DRIVER=pglite` `npm run jobs` refuses rather than open the live database a second time.

### Email

`NOTIFY_MODE=skip` (the default) logs each message instead of sending it. For a self-hosted
install, `NOTIFY_MODE=smtp` with `SMTP_URL=smtps://user:password@smtp.example.com:465` sends
through any mailbox. `NOTIFY_FROM` is the sender and `NOTIFY_REPLY_TO` is where a tenant's
reply lands. A failed send is retried five times, with the wait between tries growing from
5 minutes to 4 hours.

### Behind a reverse proxy

Sign-in limits key on the client address. Set `TRUST_PROXY=true` only when a proxy (nginx,
Caddy, a tunnel) sits in front and sets `X-Forwarded-For`; otherwise anyone could forge that
header to dodge the limit. Set `PUBLIC_API_URL` to the address people use, so document links
point there.

### Signing out

Signing out ends every session for the account, on every device: the account's session epoch
goes up and every token issued before it stops working. Changing the password does the same.

### Getting at the database

PGlite has no server and no socket. It is one process against one folder, and the API server
holds it while it runs, so there is nothing for `psql` or a GUI client to connect to. That is
the trade for needing nothing installed.

Point `DB_DRIVER` at `postgres` in `.env.selfhosted` and the usual tools work, including while
the server is running:

    npm run db:psql                      # psql against whatever the env file points at
    npm run db:psql -- -c "select * from lease limit 5"
    npm run db:dump > backup-$(date +%F).sql

Both read the credentials from `.env.selfhosted`, so they stay out of shell history. Any GUI
client (TablePlus, pgAdmin, DBeaver) connects with the same `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER` and `DB_PASSWORD` from that file.

On PGlite the same commands refuse, and say why. To read a PGlite directory, stop the server
first and open it from a script — nothing else can hold it at the same time.

What self-hosted mode does **not** change:

- It binds `127.0.0.1`. Put a TLS terminator in front of it before anyone else uses it; session
  tokens over plaintext on a shared network are the whole ballgame. `HOST=0.0.0.0` opts out.
- PGlite is one process against one folder, with no replication and no `pg_dump`. It warns once
  at startup. Back up `PGLITE_DIR` and `STORAGE_DIR` together, with the server stopped.
- `STORAGE_SECRET` derives the ID number encryption key. Changing it makes every stored ID
  number permanently unreadable. Back both secrets up somewhere other than the machine.
- Passwords are scrypt-hashed and tokens expire after seven days. There is no refresh token.
- Forgot password emails a link that works once, for 30 minutes. Only a SHA-256 of the token
  is stored, and the link is wiped from the outbox once used. Set `PUBLIC_APP_URL` to the
  address people open the app on, or the screen answers that reset is not set up. The email
  goes through the notification outbox, so it only leaves the machine with `NOTIFY_MODE=send`
  and a sender configured.
- Sign-in locks an account for 15 minutes after 10 wrong passwords, and one address for 15
  minutes after 30. Sign-ups are capped at 10 an hour per address. These counts live in
  memory, so restarting the server clears them.
- Settings → Password changes a password and signs out every other device: each token
  carries a fingerprint of the password hash, and the server checks it on every request.
- The server refuses JSON bodies over 1 MB and uploads over 15 MB (413), and sends a strict
  Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `no-referrer` with pages.
- Plain HTTP on the LAN means anyone on the same Wi-Fi can read traffic, tokens included.
  Put it behind HTTPS (Caddy or a Cloudflare tunnel) before anyone outside your house uses it.

## Before the first deploy

`serverless.yml` reads everything environment-specific from SSM, so nothing here is created by
this repo. All of these must exist before `serverless deploy` will even resolve its
configuration, and packaging fails with "AWS provider credentials not found" until they do.

| Parameter | Type | What it holds |
| --- | --- | --- |
| `/tms/<stage>/db-secret-arn` | String | Secrets Manager ARN holding `{"username","password"}` |
| `/tms/<stage>/db-host` | String | RDS Proxy endpoint |
| `/tms/<stage>/kms-key-id` | String | Key used for ID number encryption and S3 SSE |
| `/tms/<stage>/cognito-issuer` | String | User pool issuer URL |
| `/tms/<stage>/cognito-client-id` | String | App client id, the JWT audience |
| `/tms/<stage>/lambda-security-group-id` | String | Security group allowed into the proxy |
| `/tms/<stage>/private-subnet-ids` | StringList | Subnets the functions attach to |
| `/tms/<stage>/allowed-origins` | StringList | Origins the SPA is served from |
| `/tms/<stage>/notify-mode` | String | `skip` until a sending domain is verified |
| `/tms/<stage>/notify-from` | String | Address on that domain |

Also needed: the `tms-api-<stage>-docs` bucket, the Cognito user pool with `tenant` and
`landlord` groups, and the RDS instance and proxy.

Two things follow from attaching the functions to a VPC. They lose the default route to the
internet, so Secrets Manager, S3, KMS and SES each need an interface endpoint in that VPC or a
NAT gateway. And migrations run from somewhere with a route to the proxy — a bastion, a CI
runner in the VPC, or a one-off task — not from a laptop:

    cd api
    npm run certs:fetch
    DB_HOST=<proxy endpoint> DB_NAME=tms DB_SECRET_ARN=<arn> npm run migrate:deploy

`migrate:deploy` reads only the shell's environment; `npm run migrate` loads `.env`, which
is the laptop's and does not exist on a bastion. The seed files are skipped by the runner
unless `--seed` is passed, so neither ever
puts development data in a real database. A production database has no landlord row at all:
insert one with the `cognito_sub` of the real landlord before anyone signs in, or every
landlord route returns 403.

## First deploy to AWS

For a laptop, see "Running it locally" below; for your own machine serving real users, see
"Running it for real without AWS" above. For the AWS stage:

    cd api && npm install
    npm run typecheck
    npm run deploy:dev                # fetches the RDS CA bundle first
    # migrations: see "Before the first deploy" (run from inside the VPC)

    cd ../app
    echo "VITE_API_URL=https://<your-api-id>.execute-api.af-south-1.amazonaws.com" > .env
    npm run build

The documents bucket must have default encryption set to SSE-KMS with the stage's key.
Browser uploads go straight to S3 on presigned links, and those links do not carry an
encryption header (S3 would refuse the upload if they asked for one the browser never sends),
so the bucket default is what encrypts them.

## Building the APK

    cd app
    npx cap add android          # once
    npm run apk:debug            # android/app/build/outputs/apk/debug/app-debug.apk

For a release build, generate a keystore once and sign it:

    keytool -genkey -v -keystore tms.keystore -alias tms -keyalg RSA -keysize 2048 -validity 10000
    npm run apk:release

Put the keystore path and passwords in `android/keystore.properties` and keep that file out of git.
Sideload with `adb install app-debug.apk`, or upload the AAB to Play Console when you are ready.

iPhone and laptop users open the same URL and install it from the browser. No App Store review, no
Apple developer fee, and the service worker gives them offline reads.

## What the API does today

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | /auth/login, /auth/register | anyone | local sign-in and tenant sign-up; Cognito's job in production |
| POST | /auth/reset/request, /auth/reset/confirm | anyone | emailed password reset for the local driver |
| POST | /leases/{id}/payment-proofs, /payment-proofs/{id}/submit | tenant | send a proof of payment slip |
| GET | /payment-proofs | landlord | slips waiting to be checked |
| POST | /payment-proofs/{id}/decision | landlord | accept (records the payment) or reject with a reason |
| POST | /bank-imports | landlord | read a CSV or OFX bank statement into credit lines |
| GET | /bank-imports, /bank-imports/{id} | landlord | past imports; one import with a suggested lease per line |
| POST | /bank-imports/{id}/resolve | landlord | confirm lines as payments, or set them aside |
| POST, GET | /expenses | landlord | record an expense with an optional slip; list by period |
| PUT, DELETE | /expenses/{id} | landlord | correct or remove an expense |
| GET | /reports/income-expense | landlord | rent invoiced, collected, expenses and net per property, tax year by default |
| GET | /reports/arrears | landlord | what each lease owes, aged 0, 30, 60, 90 and 90+ days |
| GET, POST | /me/privacy, /me/consents | signed in | notice version accepted; accept the current one |
| GET | /me/data-export | signed in | everything held about the caller, as JSON |
| POST | /me/erasure-request | tenant | ask for erasure; immediate when there is nothing to keep |
| GET | /privacy-requests | landlord | erasure requests from their applicants and tenants |
| POST | /privacy-requests/{id}/decision | landlord | erase, or refuse with a reason |
| GET | /billing/invoices | landlord | their numbered invoices from Threshold |
| POST | /billing/invoices/{id}/render | landlord | make the invoice PDF once and return its key |
| GET | /company | public | the operator's name, registration and contact details |
| GET | /audit | landlord | the audit log for their own properties and account, newest first (`?entity=&entityId=&before=&limit=`) |
| POST | /applications | tenant | submit an application, holds the unit |
| POST | /applications/{id}/documents/presign | tenant | get a presigned S3 upload URL |
| POST | /applications/{id}/documents/confirm | tenant | record an application document once its upload has landed |
| GET | /applications | landlord | queue with rent to income band |
| POST | /applications/{id}/decision | landlord | approve or decline with a reason |
| POST | /applications/{id}/lease | landlord | generate the lease, sets it out for signature |
| POST | /leases/{id}/signature | both | sign, activates the lease when both parties are on file |
| GET | /properties | landlord | the portfolio: every unit with tenancy, rent and open applications |
| POST | /properties, /properties/{id}/units | landlord | add stock; PUT on either edits it |
| DELETE | /properties/{id}, /units/{id} | landlord | remove stock; refused whenever there is lease or application history |
| GET | /units/available | any signed-in user | vacant units for the application form |
| GET | /listings?landlord={slug} | public | one landlord's vacant, listed units with photos |
| POST, DELETE | /units/{id}/photos, /units/{id}/photos/{photoId} | landlord | add a listing photo (then `/photos/confirm`), remove one |
| GET, POST | /applications/{id}/credit-check | both | the applicant's agreement and the recorded result; the applicant agrees, the landlord records |
| GET | /applications/{id}/documents | landlord or owner | the uploaded paperwork, each with a signed view link |
| GET | /contractors | landlord | the directory that builds itself from past assignments |
| GET | /inspections/{id} | both | full inspection state: findings, photos, signatures, draft |
| POST | /inspections/{id}/render | both | prepare the unsigned draft report both parties review |
| POST | /files/view | varies | swap any stored key for a short-lived signed URL, authorised per family |

One hundred and five routes in all; the table lists the shape of each family rather than every verb.

## Rules encoded in the schema, not the UI

- A unit can carry only one live lease. Enforced by a partial unique index, not application code.
- Submitting an application holds the unit. Declining releases it.
- The deposit is a ledger, because the interest it earns belongs to the tenant.
- Every signature stores the time, IP, device and a SHA256 of the exact PDF that was on screen.
- Every state change writes to `audit_log`. Disputes are won on records.

## Next phases

2. Move-in inspection with room-by-room photos, both parties sign, PDF stored.
3. Monthly invoice run on EventBridge, payment capture, arrears ageing.
4. Maintenance tickets with contractor assignment and quote approval.
5. Notices, renewals, exit inspection, deposit reconciliation, refund.


## Running it locally

Two commands from a fresh download. Nothing to install beyond Node 20 or newer: no Homebrew,
no database server, no roles to create.

    npm run setup
    npm run dev

`setup` installs, builds the toolbox, creates both `.env` files and migrates and seeds the
database. `dev` starts the API on 3001 and the app on 5173 together.

Open http://localhost:5173.

If anything looks wrong:

    npm run doctor

It checks the six things that have actually gone wrong before, and prints the command that
fixes each one.

### The database

`DB_DRIVER=pglite` by default, which is Postgres compiled to WebAssembly running inside the API
process against `tms/api/.pglite`. It is a real Postgres, not a mock, and the same migrations
apply to it. The folder is not in git: `npm run dev` creates and seeds it when it is missing.
Delete it or run `npm run reset` to start over. `npm run dev` also applies any migrations a
pulled branch adds to an existing database, without re-seeding it.

For demos and screenshots, `npm run demo` (with `npm run dev` stopped) adds a second building,
two more tenants, three months of rent with one tenant in arrears, a year's expenses and an
overdue repair. Dates are relative to today, so the dashboard reads the same whenever you run
it. `npm run reset && npm run demo` gives a clean demo copy.

To use a real Postgres instead, set `DB_DRIVER=postgres` in `tms/api/.env` and fill in the
`DB_HOST` block below it, then `npm run setup -w tms-api`.

### Documents without AWS

`STORAGE_DRIVER=local` keeps every PDF and photo under `tms/api/.storage`, and the dev server
serves them on HMAC-signed URLs that behave exactly like presigned S3 links: they expire, they
are bound to one verb and one key, and tampering gets a 403. `KMS_DRIVER=local` does the same
for ID number encryption. Both refuse to run outside development, so a production deploy that
forgets to unset them fails loudly instead of writing documents to a Lambda's disk.

### Signing in

The app opens on a sign-in screen. Development accounts, all with password `dev`:

    landlord@example.co.za    the landlord
    naledi@example.co.za      the sitting tenant
    sipho@example.co.za       an applicant waiting on a decision

Prospective tenants create their own account from the sign-up screen, exactly as they would
against the Cognito user pool in production. `AUTH_DRIVER=local` keeps credentials in the
`local_credential` table (scrypt-hashed) and issues signed tokens the dev server verifies;
outside development those routes answer 404 and identity is Cognito's, checked by the API
Gateway authorizer before any handler runs. Switching roles is signing out and back in as
someone else, the same as it would be in production.

### Tests

    npm test

Over 350 tests. They boot their own Postgres, so nothing needs to be running. The web app's unit tests can run
on their own, without the API and while the self-hosted server is up:

    npm run test:unit -w tms-app

The app's click-through tests render screens in a DOM, press the actual buttons, and let each
press hit a real API. Documents opened by a button are downloaded and checked to be real PDFs.
`npm test` starts that API itself on port 3101, against a throwaway database and storage folder
that are deleted afterwards, so the tests never touch your development data. They used to run
against the dev API on 3001 and left a test property behind on every run.

With the self-hosted server on 3001, run them against a development API on another port
instead; the suite starts one there and stops it afterwards:

    VITE_API_URL=http://localhost:3101 npm run test:clicks -w tms-app


## Audit notes, July 2026

Fixed in migration `0006_audit_fixes.sql` and the commits alongside it:

- `cognito:groups` arrives from the HTTP API JWT authorizer as the string `[landlord tenant]`.
  The old parser kept the brackets, so `groups.includes('landlord')` was always false and every
  landlord route would have returned 403 on the first deploy.
- `GET /tickets` interpolated the `status` query parameter straight into SQL.
- Phase 2 to 4 handlers checked that a caller was signed in, never that they were a party to the
  lease. `lib/access.ts` now gates every lease-scoped route, and signatures are bound to the
  signer, so nobody can sign as the other party.
- A lease with no rendered PDF could be signed, which left a signature tied to no document.
- `lpad(uuid::text, 5, '0')` returned the whole uuid, so the payment reference printed on
  invoices was unusable. Leases and invoices now carry `ref_no` sequences.
- Photo rows were written when the presigned URL was issued. A failed upload left a row whose
  S3 object never existed, and sealing an inspection died fetching it. Uploads are now confirmed
  through `POST /photos/confirm`, and sealing skips anything missing rather than failing.
- `ssl: { rejectUnauthorized: false }` accepted any certificate. Set `RDS_CA_BUNDLE` or ship the
  AWS bundle at `/opt/rds-ca-bundle.pem`:
  `curl -o rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`

Known gaps, deliberately left for later:

- A lease that ends mid-month still receives a full month's invoice. Pro-rata is a policy
  decision and belongs with phase 5 termination.
- `landlord.cognito_sub` exists now but the seed data does not populate it. Set it before the
  first deploy or every landlord route will refuse access.
- There are no integration tests. The 22 unit tests cover the pure domain rules only.


## Phase 5, termination

Two clocks run and they are not the same unit.

- Notice periods are **business days**. The Consumer Protection Act s14 gives a tenant 20
  business days to cancel a fixed term early. `domain/termination.ts` computes South African
  public holidays, including Good Friday and Family Day from the Easter computus and the
  Public Holidays Act rule that moves a Sunday holiday to the Monday. Holidays created by
  proclamation cannot be derived; add them to `PROCLAIMED_HOLIDAYS`.
- Refund deadlines are **calendar days**, Rental Housing Act s5(3):
  7 days from the lease ending when nothing is deducted, 14 days from the dwelling being
  restored when there are deductions, 21 days when no outgoing inspection was held.

Skipping the outgoing inspection is deemed an acknowledgement that the dwelling is undamaged,
so `terminations-settle` refuses to settle with deductions attached when no outgoing inspection
was completed.

Fair wear and tear is not damage. The comparison endpoint offers a deduction only where an item
dropped two or more condition steps between the incoming and outgoing inspections; one step is
reported as wear.


## Test findings, July 2026

Eight defects found by testing against a real Postgres (PGlite) rather than mocks. Each has a
regression test that fails if the fix is reverted. `npm test` in `api/` runs all 73.

Money:
- `terminations-settle` computed the held deposit by summing only `received` and `interest`,
  ignoring any `deduction` or `refund` already posted. A deposit with prior movement was
  refunded as if nothing had left it.
- `deposit_ledger.amount_cents` had no positivity check, so a mistyped negative receipt could
  silently corrupt the balance the whole settlement is derived from. Fixed in migration `0008`.
- The invoice run selected every `active` lease. A lease stays active until the deposit is
  settled, weeks after the tenant leaves, so it billed months nobody lived there and those
  invoices came straight back off the deposit as arrears.
- `monthlyInterestCents` paid negative interest on a negative balance.

Deposit disputes:
- The exit comparison treated an item the move-in inspection never recorded as having started
  in good condition, and offered it as deductible. A landlord could charge for damage that
  predates the tenant. Now reported as `noBaseline` and refused by the deduction endpoint.
- An item the outgoing inspection skipped was reported as having improved. Now `notReinspected`.
- The statement's evidence query inner-joined the two inspections, so an item with no move-in
  record was charged for on page one and had no evidence section at all. Now a left join from
  the outgoing side, printing "not recorded" where there is no baseline.

Dates:
- `earliestEffectiveDate` returned the lease end date even when notice was served after the
  lease had already run out, producing `effective_on < notice_given_on`. The database check
  constraint rejected it, so the tenant saw an opaque 500. Late notice now ends the lease on
  the day it is given.

Also removed the `pgcrypto` extension requirement from `0001_init.sql`. Nothing used it;
`gen_random_uuid()` has been core Postgres since 13. Requiring it forced the migration user to
hold `rds_superuser` for no reason.


## Phase 6, notifications

Nothing in phases 1 to 5 ever told anyone anything. This closes that.

Written as an outbox. A notification row is inserted in the same transaction as the business
event that caused it, and `notifications-dispatch` sends it a few minutes later. That buys two
things worth an extra table: a rolled back transaction can never send a message about something
that did not happen, and a failed send never loses the message.

Event driven, raised inline: invoice issued, payment received, ticket raised, contractor
assigned, work completed, inspection booked, lease signed, notice served, deposit settled.

Time driven, raised by `notifications-sweep` every morning: maintenance about to breach its target, maintenance already overdue,
inspection tomorrow, statutory refund deadline within three days, lease ending in 60, 30 or 7
days. Every one carries a dedupe key, which is what makes the sweep safe to run as often as
you like.

Quiet hours run 20:00 to 07:00 SAST. Routine messages queue until morning; urgent ones go
straight out, because a burst geyser at 23:00 is worth waking up for. Deadline notifications
cannot be switched off in preferences, since those are the ones that cost money at a tribunal.

Templates read their fields through an accessor that throws on a missing key, so a broken
template fails loudly instead of emailing a tenant the word "undefined".

Also in this phase: `deposit_interest_rate` replaces the single `DEPOSIT_INTEREST_ANNUAL_PCT`
environment variable, so changing the rate no longer silently rewrites what every past month
should have earned.

### Deployment note

`serverless.yml` was invalid YAML from phase 1 onward. A route path containing `{id}` inside a
flow mapping is not a plain scalar, so `serverless deploy` would have failed to parse the file
on the very first attempt. Every path is now quoted, and `src/__tests__/deployment.test.ts`
parses the file, checks every handler exists, and checks no route is missing an authorizer.


## Phase 7, renewals and pro-rata

Three things were confirmed against the database before any of this was written.

1. A renewal could not be signed at all. `lease_one_active_per_unit` blocked a second lease on
   the same unit, and a renewal by definition needs one before the current lease ends. Leases
   now have a `scheduled` status: signed, immutable, not yet live. Two partial indexes replace
   the old one, so a unit has exactly one live lease and at most one queued behind it.
   `leases-activate` runs each morning and swaps them in a single transaction, because doing it
   in two would leave two live leases for an instant and the index refuses that.
2. A lease starting mid-month was never invoiced. The run compared the start date against the
   1st, so the first part month was free.
3. A lease ending mid-month was invoiced in full, and that overcharge came back off the deposit
   as arrears.

Pro-rata is charged on actual days against the real length of that month, so a February day
costs slightly more than a March day rather than the month being quietly cheaper. Invoices now
carry `covers_from` and `covers_to`, so a part month can be checked rather than trusted.

The deposit moves with the tenant. On activation the ledger is repointed at the new lease, so
the interest history carries across instead of the deposit being refunded and recollected.
Only the difference between the old deposit and the new rent is asked for, and it is never
negative, because a deposit is not partly refunded mid-tenancy.

An offer that nobody answers lapses on its deadline. Leaving it open would block the next one,
which is what the partial unique index on open offers enforces.

## Optimisation pass

**Deployment shape.** Forty-two Lambda functions became one `api` function serving all 30 HTTP
routes through `src/router.ts`, plus the five scheduled jobs. At roughly a request a minute no per-route function ever stayed warm, so
nearly every call paid a cold start. One function means any request keeps the whole API warm,
there is one log group to search, and the same process runs locally as an ordinary server.
No handler was rewritten: the router fills in `pathParameters` exactly as API Gateway did.

A side effect worth knowing: environment validation now runs once at container start for every
route, so a missing variable fails on the first request to anything rather than lurking until
someone hits the one route that needed it.

**Migrations.** `npm run migrate` pointed at a script that did not exist. There is now a runner
with a `schema_migrations` table, one transaction per file, and a checksum on every applied
migration. Editing a migration that has already run is refused rather than guessed at, because
that means the database and the repository disagree about what the schema is.

**Indexes.** Postgres does not index a foreign key just because it is one. `unit.property_id`,
`property.landlord_id` and `lease.applicant_id` sit in the join that every authenticated
request walks, and none of them were indexed. Migration `0011` covers those plus the invoice,
signature and inspection lookups.

**Workspaces.** The app depended on the toolbox through `file:../../toolbox`, which gave it a
second copy of React Query, react-hook-form and Zod. That was patched around with Vite dedupe
and a tsconfig `paths` override. npm workspaces fixes it at the root, and the `paths` override
is gone; the app typechecks without it.

**CI.** Still to do. This claimed a `.github/workflows/ci.yml` running typecheck, the tests and
a parse of the deployment file on every push; no such workflow was ever committed, and there is
no `.github` directory. `npm run typecheck --workspaces` and `npm test --workspaces` are what it
would run, and both pass, but nothing runs them automatically.

**Log retention** is set to 30 days. Groups previously kept everything forever.

**Parallel I/O.** The exit statement fetched move-in and move-out photos one at a time, so a
twenty item comparison was forty sequential S3 round trips. Those now go together, as do the
photos gathered when an inspection is sealed.

Deliberately not changed: the notification sweep still enqueues sequentially. Those writes all
go through one connection pool, so firing them in parallel would queue anyway and only risk
exhausting it.


## Removed: complex chat

Built and then taken out before it ever shipped. The migration was deleted rather than
followed by a drop, because nothing had been deployed and a create-then-drop pair in the
history helps nobody. If you had already applied it somewhere, drop the seven tables by hand
and delete the `0011_chat.sql` row from `schema_migrations`.

Removing it also took `sharp` out of the dependency tree, which was the only thing that
needed a native binary and therefore a Lambda layer.


## Deferring email

`NOTIFY_MODE` defaults to `skip`, so a fresh deploy sends nothing. Business events still write
to the outbox exactly as they will in production, and the dispatcher drains it every few
minutes, logging what each message would have been instead of sending it. The whole pipeline is
therefore exercisable before a sending domain exists.

Nothing in the request path touches SES. `notify()` only inserts a row, so all seventeen call
sites work with no email configured at all.

Two guards make switching it on later safe:

- Anything left pending for more than 24 hours is parked rather than sent. A rent reminder for
  a month already paid is worse than no reminder, and it means enabling sending cannot flood
  anyone with a backlog.
- Skip mode drains rather than accumulates, so there is no backlog to begin with.

To go live: verify a sending domain in SES, get out of the sandbox, set `NOTIFY_FROM` to an
address on that domain, and set `NOTIFY_MODE=send`. Nothing else changes.

Cognito's own emails (sign-up confirmation, password reset) do not go through SES and work
without any of this, capped at 50 a day.


## Dates

Postgres `date` columns are returned as plain `YYYY-MM-DD` strings, not JS `Date` objects.

The driver's default turns a date into local midnight, which JSON then renders in UTC. Anywhere
east of Greenwich that reads back a day early: a move-in date of 29 August arrives as
`2026-08-28T22:00:00Z`. Lambda runs in UTC and hides it completely; a laptop in Johannesburg
does not, which is how it was found.

Lease starts, invoice due dates and statutory refund deadlines are all dates rather than
instants, and a deadline that reads a day early is the kind of thing a tribunal cares about.
`src/lib/db.ts` overrides the parser for OIDs 1082 and 1182.


## Money coming in

Rent arrives by EFT, so the landlord used to type every payment. Two ways in now, both
ending in ordinary payment rows:

- Proof of payment. The tenant uploads the bank's slip from the rent screen. The landlord
  checks it against their account and accepts it, optionally with a corrected amount, or
  rejects it with a reason the tenant sees. While a slip waits, the invoice shows "proof sent"
  and the overdue reminder holds off.
- Bank statement import. The landlord uploads the CSV or OFX their bank exports. Only credits
  are read. Each line gets a suggested lease: high confidence when the `LSE-00101` reference is
  in the description and the amount fits, or a pending slip matches; medium for a surname and
  exact amount; low for an amount only one lease owes. Nothing is recorded until the landlord
  confirms. Re-importing an overlapping statement skips lines already seen. Confirming a line
  also accepts a pending slip for the same amount, so nobody ticks one payment off twice.

Either way one amount is spread over the lease's open invoices, oldest first, so a tenant
paying two months at once settles both. More than the lease owes is refused, because there is
no credit balance to hold it in yet.

CSV layouts differ by bank: FNB puts account details above the header, Capitec splits money
in and out, some exports use semicolons and decimal commas. The reader finds columns by
header and falls back to the values when there is none. Dates are read day first. OFX is the
reliable choice when the bank offers it.

## POPIA

The landlord is the responsible party; the app is what they process personal information with.

- Privacy notice at `/privacy`, public, in plain language. Its version is
  `PRIVACY_VERSION` in `api/src/domain/privacy.ts` and `app/src/lib/privacy.ts`; a test keeps
  them equal. Bump both when the notice's substance changes, and everyone is asked again.
- Consent is recorded in `consent` with the version, time, IP address and device: at sign-up,
  per application (for using the ID number, income and documents to decide it), and on first
  sign-in for anyone without the current version, landlords included.
- Settings, Your data: download everything held about you as one JSON file (the ID number shows
  its last four digits; it is never decrypted), and ask for erasure.
- Erasure: an account that never applied goes at once. Otherwise the request waits for the
  landlord, under Settings, Privacy requests, and on the overview. The system refuses to erase
  while records must be kept: five years after a lease ends (Tax Administration Act, and the
  Rental Housing Tribunal). A refusal needs a reason, which the person is emailed with the
  Information Regulator's address. Erasure replaces the person's details with placeholders,
  deletes their documents, slips, lease PDFs and signature images, their sign-in and their
  messages, and leaves amounts and dates so the books still add up.
- Retention: `privacy-sweep` runs daily and deletes the documents of applications declined or
  withdrawn more than twelve months ago.

What is not here yet: a named Information Officer per landlord shown in the notice, and
correction of details by the person themselves (they ask the landlord today).

## Arrears

`arrears-run` runs at 05:15 SAST. A lease with rent past its due date opens an arrears case,
and the tenant gets a reminder on day 1, day 3 and day 7. Only the highest reminder due is
sent, so a job that was down for a week sends one message, not three. Reminders hold while a
slip waits for the landlord, and while the landlord has paused them (60 days at most, with a
reason). Paying up closes the case.

From day 7 the landlord is told the letter of demand is ready. The system never sends it on its
own. The landlord presses Send on the lease, the letter is rendered as a PDF, filed on the lease
and emailed to the tenant. It gives 20 business days to pay, the notice the Consumer Protection
Act s14 needs before a fixed-term lease can be cancelled for breach. Every step is a row on the
case, so the lease shows who was told what, when, and for how much.

Routes: `GET /leases/{id}/arrears`, `POST /leases/{id}/arrears/letter`,
`POST /leases/{id}/arrears/pause` with `{ until, reason }`, or `{ until: null }` to resume.

## Landlord accounts

One installation serves many landlords, and each landlord account has a team: one owner and
any number of agents. Every access check asks whether the caller is a member of the landlord
that owns the record. `landlord.cognito_sub` still names the owner and a trigger keeps it in
step with `landlord_member`, so seeds and landlord notifications work as before.

- **Sign-up.** `/register?as=landlord` takes a business name and phone and opens the account
  with the person as owner. The dashboard shows a setup checklist until there is a bank account,
  a property, a unit and a tenant on a lease.
- **Agents.** The owner invites by email from Settings, Team. The link works once, for 7 days,
  and only a hash of it is stored. Agents do everything on leases, rent, maintenance,
  inspections and applications, under their own name in Activity. Only the owner changes the
  business details, the bank account or the team, deletes a property or unit, or answers a
  POPIA request. Removing an agent moves their session epoch, so they are signed out at once.
- **Bank details** print on invoices and the letter of demand and show on the tenant's rent
  screen. A change is in Activity with the old and new last four digits.
- **Listings link.** Each landlord has `/l/their-name`, a public page of their vacant units (see
  Listings below). Apply on it leads to `/apply?landlord=their-name&unit=…`. With more than one
  landlord on the installation, the vacant-unit list needs the name, so no landlord shows
  another's units.

Limits for now: landlord sign-up and invitations use the local auth driver; under Cognito they
need a sign-up flow that puts the person in the `landlord` group, which is not built. Landlord
notifications go to the owner and the business email, not to each agent.

Routes: `GET /landlord`, `PUT /landlord`, `GET /landlord/team`, `POST /landlord/invites`,
`POST /landlord/invites/{id}/revoke`, `POST /landlord/members/{sub}/remove`, and the public
`POST /invites/lookup` and `POST /invites/accept`, which take the token in the body.

## Current tenants

A landlord who starts with tenants already in place adds them under Overview, Add current
tenants: one from a form, or many from a CSV (template on the page). `POST /leases/import`
takes `rows` or `csv`; `dryRun: true` reports every problem by line, and the real run writes
all rows or none.

Each row becomes an approved application and an active lease marked `source = 'import'`, so
it stays out of the applications queue and needs no signing. The unit is marked occupied, the
deposit held goes on the ledger, and this month's rent is invoiced at import (paid or not, as
the landlord says), so the monthly run does not bill it again. Arrears from before this month
become one invoice due on the date they were first owed, and follow the arrears steps.

The rent entered is today's rent. `lease.escalates_from` is set to the last anniversary of the
lease start, and escalation counts from there, so years already past are not escalated again.

Imported tenants have no sign-in. The landlord can email them a link (`tenant_invite`, single
use, 7 days, stored hashed). A tenant with no account chooses a password; one who already has
an account must enter that account's password, so the link alone never opens an existing
account.

## Two-step sign-in and bank details

Changed bank details are how rent gets stolen: whoever controls the landlord's sign-in can
point every invoice at their own account. So:

- Anyone can turn on two-step sign-in under Settings, You: scan a QR code into an authenticator
  app, confirm a code, keep ten single-use recovery codes. Codes are RFC 6238 (SHA1, 30 s,
  6 digits), checked one step either side, and a step once used is refused. The secret is kept
  AES-GCM encrypted under a key derived from `AUTH_SECRET`; recovery codes are kept hashed.
- With it on, sign-in asks for the code after the password, and a wrong code counts as a failed
  attempt. A password reset link changes the password but no longer signs in; neither does a
  tenant's lease invitation for an account that has two-step on.
- The first bank account can be added freely. Replacing one needs the owner to have two-step on
  and to give a current code (`PUT /landlord` with `code`). Resaving the same details does not.
- On a change, the owner is emailed at the business address and their sign-in address, every
  tenant on an active lease gets a notice they cannot switch off, and the rent screen shows a
  warning beside the account for 30 days.

This applies to the local auth driver. Under Cognito, its own MFA protects the sign-in and the
bank change goes through with the same notices.

## Plans and billing

Landlords pay monthly by how many units they run. Prices live in `api/src/domain/plans.ts`
(Starter up to 5 units R199, Standard up to 20 R449, Pro up to 60 R999, VAT included) and every
screen and limit reads them from there. They are placeholders: set your own before launch.

- Every landlord account starts on a 30-day trial with room for 60 units. Paying during the
  trial keeps the trial: the paid month starts when it ends.
- A lapsed account turns read-only for the landlord and their agents: everything can be seen,
  nothing changed, except sign-in, settings, billing and their own data. Tenants are never
  stopped. A failed payment gets 7 days' grace; a cancelled plan runs to the end of the month
  paid for. Scheduled jobs (invoices, reminders, interest) keep running either way.
- Units past the plan are refused with a prompt to move up, from the form and from imports.

`BILLING_DRIVER` picks how payment works: `payfast` (the default in aws mode), `off` (the
default self-hosted: nobody is charged) or `local` (development only: the Plan screen
simulates PayFast through the same code path).

With PayFast, the Plan screen posts a signed subscription form (monthly, until cancelled) to
PayFast; card details never reach this server. PayFast then posts an ITN to
`POST /billing/notify`, which takes no sign-in. It is applied only if the signature
matches, the sender resolves to a PayFast host, PayFast confirms the data back, and the amount is
what the plan costs; each payment applies once by PayFast's payment id, and anything rejected is
kept in `billing_event` with the reason. Plan changes and cancelling go through PayFast's
subscriptions API.

Before going live, run the whole flow in the PayFast sandbox (merchant 10000100): a first
payment, a plan change, a cancellation. In particular check that `billing_date` set to the
trial's end starts the monthly charges on that date as intended.

## Terms of service and invoices

- The terms of service live at `/terms`, public and in plain language. Landlords agree to them
  when they sign up, and again whenever `TERMS_VERSION` changes (`api/src/domain/company.ts` and
  `app/src/lib/terms.ts`; a test keeps the two equal). Each acceptance is a `consent` row of
  kind `terms_of_service`, beside the privacy notice ones. Tenants do not sign them.
- The terms are a draft written against the CPA, ECTA and POPIA. Have a South African attorney
  read them before the first paying customer.
- Every payment PayFast confirms creates a numbered invoice in the same transaction
  (`billing_invoice`, numbered from 1001 by a sequence, so numbers never repeat or skip a sale).
  It keeps a copy of both parties' details as they were that day, is emailed to the owner, and
  is listed on the Plan screen with its PDF.
- `COMPANY_*` in the environment sets who the supplier is. With `COMPANY_VAT_NO` set, the PDF is a
  tax invoice: the words, both VAT numbers and 15% VAT taken out of the inclusive price. The
  landlord's own VAT number goes under Settings, Account.

## Listings

- `/l/their-name` needs no sign-in, so a landlord can put it on Property24, Facebook or a
  WhatsApp status. It shows vacant units only: photos, rent, deposit, bedrooms, bathrooms,
  parking, furnished, pets, the date it is free and a description. The suburb shows; the
  street address and anything about tenants do not.
- Listing details and up to 12 photos are edited in the unit's drawer on Properties. A unit can
  be hidden from the page with "Show on my listings page" switched off.
- Photos take the same path as repair photos: a presigned upload, then `/photos/confirm` reads
  the bytes, refuses anything that is not a real JPEG or PNG and keeps its own copy. The app
  redraws each photo through a canvas first, which drops EXIF, so a phone's GPS position never
  reaches the public page.
- Photo links on the page are signed and last an hour; the page refetches before they expire.
- Apply goes through sign-in or sign-up and keeps the landlord and the unit, so the applicant
  lands on the form for the unit they picked.

## Credit checks

- Threshold does not query a credit bureau. The landlord runs the check with their own
  TransUnion, Experian, XDS, Compuscan or TPN account and records it on the application: the
  bureau, the date, the score, judgements, defaults, an outcome (clear, minor issues, adverse)
  and the bureau's report as a PDF.
- Nothing is recorded without the applicant's agreement. They can give it on the application
  form (an optional box) or later from their documents screen. It is a `consent` row of kind
  `credit_check` tied to the application.
- The report is filed as an application document of kind `credit_report`, which only the
  landlord can upload. So it is shown, exported, swept twelve months after a decline, and
  erased by the same rules as payslips and ID copies; the recorded result goes with it.
- The applicant sees the recorded result and the report on their application, which POPIA
  section 23 gives them and which lets them dispute an error with the bureau.
- The privacy notice changed to say all this (version 2026-10-28), so everyone is asked to agree
  to it again on their next sign-in.
- A direct bureau integration needs a subscriber contract with a bureau or TPN, their API
  credentials, and registration as a user of credit information. It would fill the same record.

## WhatsApp

Every notification already queued a WhatsApp copy for anyone with a phone number; nothing sent
it. With `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` set (Meta's WhatsApp Cloud API), the
dispatcher sends it. WhatsApp only lets a business start a conversation with an approved
template, so every message goes through one, `WHATSAPP_TEMPLATE` (default `threshold_update`):
create it in Meta Business Manager as a Utility template with one body parameter, for example
"Threshold update: {{1}} Open the app for the details." The notice's subject and text fill the
parameter, flattened to one line under 900 characters as Meta requires. A number that is not
on WhatsApp is parked, not retried; email still reaches the person. `WHATSAPP_API_VERSION`
defaults to v23.0: move it up as Meta retires versions.

## Charges on top of rent

Landlords add water, electricity, levies or one-off charges on the lease page.
`POST /leases/{id}/charges` takes the month, kind (`utility` or `other`), what it is for and the
amount. A charge goes on that month's invoice while it is not due yet, and the tenant is told.
For a month already due it goes on the next invoice instead, named for its month ("Water
(October 2026)"), so a charge is never overdue the day it is added. For a month not invoiced
yet it waits in `pending_charge` and the monthly run adds it. A charge comes off only while it
is unpaid. Invoice totals move by the charge's amount rather than being summed from lines,
because older invoices carry a total with no lines.

## Expenses and reports

Expenses are recorded per landlord, optionally against a property and a unit, in categories
that follow what SARS lets a landlord deduct. Bond interest has its own category because the
capital part of a bond payment is not deductible. A slip photo or PDF can go with each one;
only its landlord can open it.

The income report defaults to the current tax year (1 March to the end of February) and shows
two income figures per property: rent invoiced in the period, and rent collected in it. Net is
collected less expenses. Deposits are left out, because they are the tenant's money. The arrears
report ages each lease's unpaid invoices into the same buckets the tenant's statement uses, and
flags leases with a slip waiting. Both download as CSV for an accountant.

CI runs on every push and pull request (`.github/workflows/ci.yml`): a clean `npm ci`,
typecheck, toolbox lint, every test suite and the self-hosted build.

## Design

The look borrows from three products with in-house design teams: Mercury for its calm
(paper-white pages, black primary buttons, room to breathe), Stripe for data (rows split by thin
rules, figures that line up, colour only for state) and Monzo for the tenant's side (one warm,
tinted panel for their own money, plain friendly copy).

- Page titles and money are set in Source Serif 4, like a bank statement. Everything else is IBM
  Plex Sans, with IBM Plex Mono for references such as LSE-00101. The fonts are bundled, Latin
  subset only, because the self-hosted CSP allows nothing from another origin and the Android app
  must work offline.
- Panels are flat white with a 1px rule. There are no drop shadows on the page, no pill shapes and
  no gradients.
- One accent, bottle green, for links, focus and selection. Primary buttons are ink black, so each
  screen has one obvious next step.
- Labels are small and in sentence case. Use the `label` class rather than spaced-out capitals.
- Every signed-in page starts under the logo: use `PAGE` from `app/src/lib/layout.ts` for the
  `<main>`. `wide` for tables, `reading` or `narrow` for forms and text, which caps each block's
  line length without moving the left edge.
- Status badges use the `--tb-*-ink` tokens for their text, so a 12px badge clears WCAG's 4.5:1
  on its own tint. A state colour alone (`text-warning`) is fine on white, not on a tint.
- On a phone every control is at least 44px tall. Small text actions such as Edit or Lease get
  `min-h-11 sm:min-h-0`, and an `aria-label` naming what they act on ("Edit A1").
- Type comes from a fixed scale in the Tailwind preset: `text-2xs` 11, `xs` 12, `meta` 13,
  `body` 14, `lead` 15, `title` 20, `figure` 24, `display` 30, `hero` 42. No screen sets a
  pixel size by hand. `cn()` knows these names, so a size never knocks out a text colour.
- Every standalone money figure is `<Money cents={…} />`: serif figures with a quiet R, the way a
  statement prints them. `whole` drops ",00" on whole rands for headline figures. Money inside a
  sentence stays plain text.
- Vacant is a neutral badge, not a warning: an empty unit is normal. Warning and danger are kept
  for things that need doing.
- Light and dark follow the device, live, unless the person picks one under Settings, You. Only
  an explicit pick is stored. Colours come from tokens, so dark mode needs no screen changes;
  never use `bg-white`, `text-white` or `bg-ink` for a surface or a button.
- Every signed-in page has a "Skip to content" link, and the page keeps focused controls clear
  of the sticky top bar and the phone tab bar (`scroll-padding` in `index.css`). Controls are at
  least 24px, 44px on phones.
- Charts follow the emphasis form: the series that matters in the accent, its context in
  `--tb-chart-context`, a tooltip on every mark and a screen-reader table with the same figures.
- An axe scan of the main screens, light and dark, phone and laptop, reports no WCAG 2.2 AA
  violations; keep it that way when adding a screen.

The values live in `toolbox/src/tokens/tokens.css`; components read them, screens never hardcode a
colour.

## Screens

Tenant and landlord share the same app; navigation, permissions and data follow the role. On a
phone the main sections sit in a bottom tab bar, with the rest behind More; on a laptop they sit
in the top bar. Dates read "7 Oct 2026" and statuses read as words ("Unpaid", "Part paid"),
through `app/src/lib/format.ts`.

| Screen | Route | Who |
| --- | --- | --- |
| Landlord overview: month's collections, arrears, slips and repairs, a "Needs you" list, every lease | `/` | landlord |
| Tenant home: balance, rent, deposit with interest, what needs attention | `/` | tenant |
| Documents: lease, every inspection, every invoice | `/documents` | tenant |
| Lease detail: invoices, inspections, renewal, notice, record payment | `/leases/:id` | both, actions landlord only |
| Rent and deposit statement, EFT reference, send proof of payment | `/leases/:id/rent` | both |
| Properties: portfolio, add, re-price and remove units, copy application links | `/properties` | landlord |
| Applications queue: affordability banding, paperwork, generate the lease | `/applications` | landlord |
| Lease signing: review the PDF, then each party signs against its fingerprint | `/lease/:id` | both |
| Maintenance list | `/tickets` | both |
| Activity: the audit log for your properties and account | `/activity` | landlord |
| Ticket detail: assign, quote, approve, start, complete, comment, close and rate | `/tickets/:id` | both, by role |
| Report a problem | `/leases/:id/tickets/new` | tenant |
| Inspection room list and room detail | `/inspections/:id` | both |
| Termination: then-and-now comparison, deductions, settlement | `/terminations/:id` | landlord |
| Notification preferences | `/settings/notifications` | both |
| Apply and upload documents | `/apply` | prospective tenant |
| Payments: slips to check, bank statement import and matching | `/payments` | landlord |
| Reports: income and expenses per property, arrears age analysis, expense capture, CSV export | `/reports` | landlord |
| Sign in, create an account | `/login`, `/register` | anyone |
| Forgot password, choose a new one from the emailed link | `/forgot-password`, `/reset-password` | anyone |
| Privacy notice | `/privacy` | anyone |
| Terms of service | `/terms` | anyone |
| Listings | `/l/{slug}` | anyone |

The state machine lives on the server. Screens read `viewer.isLandlord` and the current status
from the API rather than deciding for themselves what is allowed, so the UI cannot drift from
what the handlers actually permit.
