# YYC Transit — Hosting Instructions

## Best Option for Public Use: Railway.app

Railway is the best choice for this app because:
- Free tier available (enough for a public transit app)
- Runs Node.js natively (no config needed)
- Automatic HTTPS
- Deploy from GitHub in 2 minutes
- Custom domain support (e.g. yyctransit.ca)

---

## Step-by-Step Deployment

### 1. Install Git (if you don't have it)
Download from: https://git-scm.com/downloads

### 2. Create a GitHub Account
Go to: https://github.com → Sign Up (free)

### 3. Push your project to GitHub

Open Terminal (Mac) or Command Prompt (Windows) in the yyc-transit folder:

```bash
cd yyc-transit
git init
git add .
git commit -m "Initial commit"
```

Then on GitHub:
- Click + → New Repository
- Name it: yyc-transit
- Set to Public
- Click "Create repository"
- Copy the commands shown under "push an existing repository"

It will look like:
```bash
git remote add origin https://github.com/YOURNAME/yyc-transit.git
git branch -M main
git push -u origin main
```

### 4. Deploy on Railway

1. Go to: https://railway.app
2. Click "Start a New Project"
3. Click "Deploy from GitHub repo"
4. Connect your GitHub account
5. Select your yyc-transit repository
6. Railway automatically detects Node.js and deploys

### 5. Set Environment Variables on Railway

In your Railway project dashboard:
- Click on your service
- Go to "Variables" tab
- Add:
  - Key: ADMIN_PASS   Value: (choose a strong password)
  - Key: PORT         Value: 3000  (Railway sets this automatically, but good to confirm)

### 6. Get your public URL

Railway gives you a URL like:
  https://yyc-transit-production.up.railway.app

That's your live app! Share it with anyone.

---

## Custom Domain (Optional)

To use a domain like yyctransit.ca:
1. Buy a domain from Namecheap (~$15/year for .ca)
2. In Railway → Settings → Domains → Add custom domain
3. Follow the DNS instructions Railway shows you
4. Done — your app runs at your own domain

---

## Admin Panel

Access the admin panel:
1. Open your app URL
2. Tap the ⚙️ button (top right)
3. Enter your ADMIN_PASS
4. Post messages, warnings, or alerts visible to all users

---

## Updating the App

Any time you make changes:
```bash
git add .
git commit -m "Update"
git push
```
Railway automatically redeploys within 30 seconds.

---

## Troubleshooting

Q: App shows "Server not reachable"
A: Make sure Railway deployment succeeded — check the logs in Railway dashboard.

Q: No buses showing
A: The server fetches from Calgary's Open Data portal. If data.calgary.ca is down, no data will show. Check https://data.calgary.ca for status.

Q: Location not working on iPhone
A: Safari on iPhone requires HTTPS for geolocation. Railway provides HTTPS automatically, so this should work on the live URL. It won't work if you open the file locally.

Q: How do I check logs?
A: In Railway dashboard → your service → "Deployments" → click the latest → "View Logs"
