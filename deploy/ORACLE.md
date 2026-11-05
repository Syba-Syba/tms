# Hosting Threshold free on Oracle Cloud

Oracle's Always Free tier gives one ARM server that stays free with no time limit. This kit
(`docker-compose.yml`, Postgres, Caddy, backups) runs on it unchanged. Plan on about an hour.

What you get: a server in Johannesburg (tenant data stays in South Africa, the simplest
position under POPIA), HTTPS on a free web address, nightly backups, and the app running all
day without your laptop.

Check Oracle's current Always Free limits before you start. Free tiers change.

## 1. Create the Oracle account

1. Sign up at cloud.oracle.com. Choose **South Africa Central (Johannesburg)** as your home
   region. You cannot change it later, and Always Free servers only run in the home region.
2. Oracle asks for a credit card to confirm who you are. Always Free resources are not charged.
   Do not click "Upgrade to Pay As You Go" unless you mean to pay for more.

## 2. Create the server

In the Oracle console: **Compute, Instances, Create instance**.

1. **Name:** `threshold`.
2. **Image:** change it to **Canonical Ubuntu 24.04**.
3. **Shape:** change it to **Ampere, VM.Standard.A1.Flex**. Set **2 OCPUs and 12 GB memory**.
   That is well inside the free limit (4 OCPUs, 24 GB) and plenty for this app.
4. **Networking:** keep the defaults (a new virtual network, and **Assign a public IPv4
   address** ticked).
5. **SSH keys:** choose **Generate a key pair for me** and download **both** keys. Without the
   private key you cannot log in.
6. **Boot volume:** tick **Specify a custom boot volume size** and set **100 GB**. The free tier
   includes 200 GB in total.
7. Press **Create**. When it shows **Running**, copy the **Public IP address**.

**"Out of capacity" error:** free ARM servers are popular. Try a different **Availability
domain** on the same page, or try again in a few hours.

## 3. Open the web ports in Oracle's firewall

The server needs ports 80 and 443 open for HTTPS.

1. On the instance page, click the **Subnet** link, then the **Default Security List**.
2. **Add Ingress Rules**, twice:
   - Source CIDR `0.0.0.0/0`, IP protocol **TCP**, destination port `80`
   - Source CIDR `0.0.0.0/0`, IP protocol **TCP**, destination port `443`

## 4. Get a free web address

1. Go to duckdns.org and sign in (GitHub or Google works).
2. Add a subdomain, for example `threshold-demo`, and set its IP to the server's public IP.
3. Your address is now `threshold-demo.duckdns.org`. Caddy gets the HTTPS certificate for it
   automatically on first start.

A `.co.za` address costs about R100 a year. Point its A record at the same IP when you want one.

## 5. Log in to the server

On your Mac, using the private key you downloaded:

    chmod 600 ~/Downloads/ssh-key-*.key
    ssh -i ~/Downloads/ssh-key-*.key ubuntu@YOUR_PUBLIC_IP

Everything from here runs on the server.

## 6. Prepare the server

Open ports 80 and 443 in Ubuntu's own firewall, then install Docker. Oracle's Ubuntu image
blocks the ports even after step 3. Save the firewall rules before Docker is installed:
Docker adds its own chains, and saving after it would write those into the saved rules,
where they clash with the ones Docker creates on the next boot.

    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
    sudo netfilter-persistent save
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker ubuntu
    exit

Log in again (step 5) so the Docker group takes effect, then check:

    docker run --rm hello-world

## 7. Get the code

The repository is private, so GitHub asks for a username and a token, not your password.
Create one at GitHub, **Settings, Developer settings, Personal access tokens, Fine-grained
tokens**: only this repository, **Contents: Read-only**.

    git clone https://github.com/Syba-Syba/tms.git
    cd tms/deploy

## 8. Fill in the settings

    cp .env.production.example .env.production
    cp backup.env.example backup.env
    for i in 1 2 3; do openssl rand -hex 32; done      # three database passwords
    for i in 1 2; do openssl rand -base64 48; done     # AUTH_SECRET and STORAGE_SECRET
    nano .env.production

Set these, using your DuckDNS address:

    DOMAIN=threshold-demo.duckdns.org
    PUBLIC_APP_URL=https://threshold-demo.duckdns.org
    PUBLIC_API_URL=https://threshold-demo.duckdns.org
    DB_PASSWORD=<first password>
    DB_SERVER_PASSWORD=<second password>
    DB_BACKUP_PASSWORD=<third password>
    AUTH_SECRET=<first base64 value>
    STORAGE_SECRET=<second base64 value>
    NOTIFY_MODE=skip
    BILLING_DRIVER=off
    ALERT_EMAIL=you@example.com

`NOTIFY_MODE=skip` logs emails instead of sending them. Switch to `smtp` with a real
`SMTP_URL` when you want password resets and notices delivered (Brevo's free plan works).
`BILLING_DRIVER=off` charges nobody. Use `payfast` with sandbox details to test billing.

Copy `.env.production` to your password manager. `STORAGE_SECRET` is the key to stored ID
numbers: lose it and they cannot be read, even from a backup.

## 9. Start it

    docker compose --env-file .env.production up -d --build

The first build takes 5 to 10 minutes. Then:

    docker compose --env-file .env.production ps        # app, db, caddy, backup: running
    docker compose --env-file .env.production logs app | tail -20

Open `https://threshold-demo.duckdns.org/register?as=landlord` and sign up. That is the first
landlord account. The server starts empty: there is no demo data on it.

## 10. Before real landlords use it

- **Rehearse a restore once:** `sh ~/tms/deploy/drill.sh`. It runs on a throwaway copy and
  ends with `DRILL PASSED`.
- **Copy backups off the server:** fill in `backup.env` with a free Cloudflare R2 or
  Backblaze B2 bucket (see `README.md`, "Encrypting the copies off the server").
- **Monitor it:** point a free UptimeRobot check at `https://your-address/health`.

## Updating

    cd ~/tms && git pull
    cd deploy && docker compose --env-file .env.production up -d --build

## If something does not work

| What you see | Usually |
|---|---|
| The browser cannot reach the address | Step 3 or 6 skipped: a port is still closed. |
| A certificate warning | DuckDNS does not point at the server's IP yet, or ports 80/443 are closed. Fix it, then `docker compose --env-file .env.production restart caddy`. |
| `required variable ... is missing` | A setting in step 8 is still empty. |
| The app restarts over and over | `docker compose --env-file .env.production logs app` names the cause. |

Oracle can reclaim Always Free servers that sit almost completely idle for a week. One serving
the app and running nightly jobs normally counts as in use.
