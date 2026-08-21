# Deploying TAMS — srv1860447.hstgr.cloud

Tailored to what is actually installed on your VPS, checked on 2026-08-21.

## What you already have

| Component | Status | Consequence |
|---|---|---|
| Ubuntu 22.04 LTS | running | — |
| Nginx | **active**, serving :80 and :443 | Add a server block. Never `restart`, only `reload`. |
| Node.js | **v20.20.2** | Nothing to install. |
| PostgreSQL | **14.23**, bound to 127.0.0.1 only | Nothing to install, and it's already private. |
| PM2 | **7.0.3** | Nothing to install. |
| RAM | 3.8 GB total, 3.1 GB available | Enough to build on the server. |
| Swap | **none** | Worth adding 2 GB before the build. |

## The one thing that changes the plan

Port **5000 is already taken** by your other project:

```
LISTEN  *:5000   users:(("node /root/app/",pid=143856))
```

So **TAMS runs on port 5001**. Every command below uses 5001. If you paste
5000 anywhere, the app will fail to start and — worse — you might confuse
the two projects while debugging.

Your other app runs as `root` out of `/root/app`, managed by PM2. TAMS will
sit next to it as a second PM2 process. Running web apps as root isn't ideal,
but you already do, and introducing a second user would give you two separate
PM2 daemons, which causes real confusion later. Staying consistent is the
better trade here. Moving both to a non-root user is a good future cleanup.

---

## 1. A few more facts I need

Run this and send me the output — the Nginx config depends on it:

```bash
ls /etc/nginx/sites-enabled/
nginx -T 2>/dev/null | grep -E "^\s*server_name" | sort -u
certbot --version 2>/dev/null || echo "no certbot"
pm2 list
systemctl is-enabled pm2-root 2>/dev/null || echo "PM2 STARTUP NOT CONFIGURED"
df -h /
```

Two of these matter a lot:

**`systemctl is-enabled pm2-root`** — if this says *not configured*, then
your existing project will **not** come back after a reboot. Your server is
already asking for a restart, so this is worth knowing before you reboot it.

**`server_name`** — tells me which domains are in use, so the new block
doesn't collide with your existing site.

---

## 2. Add swap (recommended, 2 minutes)

You have no swap. The React build is the most memory-hungry thing that will
ever run here, and if it hits the ceiling the kernel may kill *another*
process — possibly your other app — to free memory.

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h        # Swap should now show 2.0Gi
```

---

## 3. Database

PostgreSQL is already running. Just add a database and a user that owns
only it — it will not touch whatever your other project uses.

```bash
sudo -u postgres psql
```

```sql
CREATE USER tams_user WITH PASSWORD 'pick-a-long-random-password';
CREATE DATABASE tams_db OWNER tams_user;
GRANT ALL PRIVILEGES ON DATABASE tams_db TO tams_user;
\c tams_db
GRANT ALL ON SCHEMA public TO tams_user;
\q
```

---

## 4. Secure the connection first

Everything below travels over SSH, which is already encrypted. What's worth
improving is *how you authenticate*. Right now the server accepts a root
password, which means anyone on the internet can keep guessing it — and
they will, constantly.

### 4a. Use a key instead of a password

On **your Windows PC**, in PowerShell:

```powershell
ssh-keygen -t ed25519 -C "ahmed-laptop"
```

Press Enter at each prompt. A passphrase is optional but sensible — it
protects the key if your laptop is ever stolen.

Copy the public half to the server:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@187.77.177.86 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
```

Open a **new** terminal and confirm it logs in without asking for a password:

```powershell
ssh root@187.77.177.86
```

### 4b. Turn off password logins

**Only once key login definitely works.** Get this wrong and you lock
yourself out — though Hostinger's browser Terminal is always a way back in.

```bash
nano /etc/ssh/sshd_config
```

Set these three:

```
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
```

```bash
sshd -t && systemctl reload ssh
```

`sshd -t` checks the config first. Keep your current session open and test a
new one before closing it.

---

## 5. Get the code onto the server

Your other project is in `/root/app`. Keep TAMS clearly separate.

### Option A — git (recommended)

Best because updates later are one `git pull`.

```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/AhmedHaadi12167/tams.git tams
cd tams
```

If the repo is **private**, give this one server read-only access with a
deploy key rather than putting your GitHub password anywhere:

```bash
ssh-keygen -t ed25519 -C "tams-vps" -f ~/.ssh/tams_deploy -N ""
cat ~/.ssh/tams_deploy.pub
```

Paste that key into GitHub → your repo → Settings → Deploy keys → Add,
leaving "Allow write access" **unchecked**. Then tell SSH to use it:

```bash
nano ~/.ssh/config
```

```
Host github.com
    IdentityFile ~/.ssh/tams_deploy
    IdentitiesOnly yes
```

```bash
git clone git@github.com:AhmedHaadi12167/tams.git /var/www/tams
```

A deploy key only works for that one repository and can't push. If the
server is ever compromised, the attacker can't rewrite your code.

### Option B — copy straight from your PC

Use this if you'd rather the code never sits on GitHub. From PowerShell:

```powershell
cd "C:\Users\HP\Documents\Senior Projects"
scp -r tams root@187.77.177.86:/var/www/
```

This is encrypted end to end. Two warnings:

`node_modules` will be copied too — thousands of files, very slow. Delete
`client/node_modules` and `server/node_modules` locally first, or use rsync,
which can skip them:

```powershell
rsync -avz --exclude node_modules --exclude .git --exclude .env `
  ./tams/ root@187.77.177.86:/var/www/tams/
```

The downside of Option B is that updates mean re-copying every time. Git is
worth the small setup.

### What must never be transferred

`.env` is gitignored and excluded above **deliberately**. It holds your
database password and Anthropic key. You create it fresh on the server in
step 6, and the production one should have *different* secrets from your
development one anyway.

---

## 6. Server config

```bash
cd /var/www/tams/server
npm install --omit=dev
nano .env
```

Note `PORT=5001`:

```env
PORT=5001
NODE_ENV=production

DB_HOST=localhost
DB_PORT=5432
DB_NAME=tams_db
DB_USER=tams_user
DB_PASSWORD=the-password-from-step-3

JWT_SECRET=paste-output-of-the-command-below
JWT_EXPIRES_IN=7d

ANTHROPIC_API_KEY=sk-ant-api03-your-key

UPLOAD_PATH=/var/www/tams-uploads
MAX_FILE_SIZE=10485760

CLIENT_URL=https://tams.ecosagency.com

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-gmail-app-password
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
chmod 600 .env
```

### Uploads live outside the repo

```bash
mkdir -p /var/www/tams-uploads
```

Ticket PDFs and cargo photos are real files. Keeping them out of the code
folder means a `git pull` or a re-clone can never destroy them.

### Create the tables

Fresh database, so **one file does everything** — `schema.sql` already
contains all nine migrations' worth of structure:

```bash
cd /var/www/tams/server
psql -U tams_user -d tams_db -h localhost -f config/schema.sql
```

You should see a stream of `CREATE TABLE` / `CREATE INDEX` lines and no
`ERROR`. Confirm:

```bash
psql -U tams_user -d tams_db -h localhost -c "\dt"
```

Expect about 16 tables including `tickets`, `visa_applications`, `packages`,
`agents`, `airline_payments`.

### Your first login

There is no public sign-up. Create the super admin by hand:

```bash
cd /var/www/tams/server
node -e "console.log(require('bcryptjs').hashSync('YourStrongPassword', 12))"
```

```bash
psql -U tams_user -d tams_db -h localhost
```

```sql
INSERT INTO users (name, email, password_hash, role)
VALUES ('Ahmed Haadi', 'ahmedhaadi645@gmail.com', 'paste-the-hash', 'super_admin');
```

A super admin has no `business_id` — that's correct. Log in, then create the
agency and its admin from the Businesses page.

---

## 7. Build the frontend

You have the RAM for it, especially with swap added:

```bash
cd /var/www/tams/client
npm install
NODE_OPTIONS=--max-old-space-size=2048 npm run build
```

On a single vCPU this takes several minutes and looks frozen. Let it run.
Success ends with `The build folder is ready to be deployed.`

---

## 8. Start the API on port 5001

```bash
cd /var/www/tams/server
pm2 start index.js --name tams-api
pm2 save
```

`pm2 save` matters — it records both apps so they restart together.

Check it came up:

```bash
pm2 list                      # tams-api should be 'online'
curl http://127.0.0.1:5001/health
```

Expect `{"status":"ok","timestamp":...}`.

If `pm2 startup` was never configured (step 1), fix it now — this protects
your *existing* app too:

```bash
pm2 startup systemd
# run the sudo line it prints
pm2 save
```

---

## 9. Nginx

```bash
nano /etc/nginx/sites-available/tams
```

```nginx
server {
    listen 80;
    server_name tams.ecosagency.com;

    client_max_body_size 15M;

    root /var/www/tams/client/build;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;   # AI extraction can be slow
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:5001;
        proxy_set_header Host $host;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/tams /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

**`nginx -t` before reload is not optional.** A syntax error plus a restart
would take your existing site offline. `reload` with a valid config drops
nothing.

---

## 10. Domain and HTTPS

DNS record at your provider:

```
Type: A    Name: tams    Value: 187.77.177.86    TTL: 3600
```

Wait until `ping tams.ecosagency.com` returns the VPS IP, then:

```bash
certbot --nginx -d tams.ecosagency.com
```

You already serve :443, so Certbot is very likely installed. If not:
`apt install -y certbot python3-certbot-nginx`.

Afterwards confirm `CLIENT_URL` in `.env` starts with `https://`, then:

```bash
pm2 restart tams-api
```

A mismatch here produces CORS errors that look like the API is down.

---

## 11. Firewall

```bash
ufw status
```

If inactive, and only if you're happy to enable it:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

Note that 5000, 5001 and 5432 stay closed. Both Node apps and PostgreSQL
remain reachable only through Nginx and from the machine itself.

---

## 12. Backups

The database is the business — every ticket, payment and balance.

```bash
mkdir -p /var/backups/tams
nano /root/backup-tams.sh
```

```bash
#!/bin/bash
set -e
STAMP=$(date +%F_%H%M)
export PGPASSWORD='your-db-password'
pg_dump -U tams_user -h localhost tams_db | gzip > /var/backups/tams/db_$STAMP.sql.gz
tar -czf /var/backups/tams/uploads_$STAMP.tar.gz -C /var/www tams-uploads
find /var/backups/tams -name '*.gz' -mtime +30 -delete
```

```bash
chmod 700 /root/backup-tams.sh
crontab -e
```

```
0 2 * * * /root/backup-tams.sh >> /var/log/tams-backup.log 2>&1
```

Then do the step people skip — prove a backup restores:

```bash
sudo -u postgres createdb restore_test
gunzip -c /var/backups/tams/db_*.sql.gz | psql -U tams_user -h localhost restore_test
psql -U tams_user -h localhost restore_test -c "SELECT COUNT(*) FROM tickets;"
sudo -u postgres dropdb restore_test
```

Backups on the same disk protect against mistakes, not disk failure. Copy
them off the server periodically.

---

## 13. Updating later

```bash
cd /var/www/tams && git pull
cd server && npm install --omit=dev
# only when the update ships a new migration:
# psql -U tams_user -d tams_db -h localhost -f config/migration_vN.sql
cd ../client && npm install && NODE_OPTIONS=--max-old-space-size=2048 npm run build
pm2 restart tams-api
```

`.env` and `/var/www/tams-uploads` are never touched by this.

---

## About that pending reboot

Your login banner says *** System restart required ***. Before rebooting,
make sure PM2 will bring **both** apps back:

```bash
systemctl is-enabled pm2-root    # want: enabled
pm2 save                          # snapshot the current process list
```

If that says anything other than `enabled`, configure it first (step 8) —
otherwise the reboot takes your existing project down and it won't return
on its own.

---

## Troubleshooting

**502 Bad Gateway** — Nginx is fine, Node isn't. `pm2 logs tams-api`.

**Port already in use on start** — you used 5000 instead of 5001.

**CORS errors** — `CLIENT_URL` doesn't exactly match the browser's address
bar, usually `http` vs `https`.

**"relation ... does not exist"** — `schema.sql` didn't finish. Re-run it and
read the first `ERROR`, not the last.

**Blank page, MIME type error in console** — Nginx `root` isn't pointing at
`client/build`, or the build never completed.

**Uploads 404** — check `/var/www/tams-uploads` exists and `UPLOAD_PATH`
matches it exactly.
