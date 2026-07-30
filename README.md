# ClickUp Dashboard

A dashboard that pulls task data from ClickUp and displays project management analytics. Hosted on Netlify with API key secured server-side.

## Features

- **Main Dashboard** — KPIs, pipeline overview, status/priority/workload charts, task table
- **Progress Tracker** — Filter tickets by date range to see team productivity
- **Developer Progress** — Track developer output with smart attribution logic
- **Configurable Roles** — Set PMs and testers from the UI to improve dev credit accuracy

## Setup

### 1. Deploy to Netlify

1. Push this repo to GitHub
2. Go to [app.netlify.com](https://app.netlify.com) → "Add new site" → Import from GitHub
3. No build command needed — Netlify auto-detects the functions directory

### 2. Set Environment Variable

In Netlify: Site Settings → Environment Variables → Add:

- **Key:** `CLICKUP_KEY`
- **Value:** Your ClickUp API token (starts with `pk_`)

### 3. Get your List ID

1. Open the ClickUp list you want to track
2. The List ID is in the URL: `https://app.clickup.com/9016594613/v/b/6-901609965646-2`
   - List ID = `901609965646`

### 4. Configure the Dashboard

1. Open your Netlify site URL
2. Click ⚙️ Settings if you need to change the List ID
3. On the Developer page, configure PM and Tester roles for accurate attribution

## Architecture

```
Browser → Netlify Function (/.netlify/functions/clickup-proxy) → ClickUp API
                                    ↑
                          CLICKUP_KEY env var injected here
```

- The API key **never** reaches the browser
- The Netlify function acts as a secure proxy
- Only `/api/v2/` paths are allowed (prevents misuse)

## Security

- API key stored exclusively in Netlify environment variables
- Never exposed to frontend code or browser
- Serverless function proxies all requests
- No localStorage secrets, no client-side tokens

## Local Development

To run locally with Netlify CLI:

```bash
npm install -g netlify-cli
netlify dev
```

This will inject the env variables locally and serve the functions.

## Pages

- `index.html` — Main dashboard with full overview
- `progress.html` — Date-range filtered progress tracker
- `developers.html` — Developer-specific progress with role configuration
