# ClickUp Dashboard

A static dashboard that pulls task data directly from your ClickUp lists and displays KPIs, charts, and a task table. Hosted for free on GitHub Pages or Netlify.

## Features

- **KPI cards** — Total, Open, In Progress, Completed, Overdue tasks
- **Status breakdown** — Doughnut chart with ClickUp's own status colors
- **Priority distribution** — Bar chart by priority level
- **Assignee workload** — Horizontal bar chart showing who has the most tasks
- **Timeline** — Tasks created per week over time
- **Filterable task table** — Filter by status or priority, links directly to ClickUp

## Setup

### 1. Get your ClickUp API Token

1. Go to ClickUp → Settings → Apps
2. Click "Generate" under API Token (or use an existing one)
3. Copy the token (starts with `pk_`)

### 2. Get your List ID

1. Open the ClickUp list you want to track
2. Click the `...` menu → "Copy Link"
3. The List ID is the number in the URL: `https://app.clickup.com/9016594613/v/li/901611289144`
   - In this example, List ID = `901611289144`

### 3. Deploy

#### Option A: GitHub Pages

1. Create a new GitHub repository
2. Push this folder to the repo:
   ```bash
   cd clickup-dashboard
   git init
   git add .
   git commit -m "Initial dashboard"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/clickup-dashboard.git
   git push -u origin main
   ```
3. Go to repo Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder: `/ (root)`
4. Your dashboard will be live at `https://YOUR_USERNAME.github.io/clickup-dashboard/`

#### Option B: Netlify

1. Go to [app.netlify.com](https://app.netlify.com)
2. Click "Add new site" → "Import an existing project" → connect your GitHub repo
3. Build settings are already configured in `netlify.toml` (no build command needed)
4. Click "Deploy site"
5. Or drag-and-drop this entire folder onto Netlify's deploy page for instant deployment

### 4. Configure the Dashboard

1. Open the deployed dashboard URL
2. Enter your ClickUp API Token and List ID in the config panel
3. Click "Save & Load Data"
4. Your credentials are stored in your browser's localStorage only — never sent to any server besides ClickUp's API

## Security Notes

- API key is stored in **your browser's localStorage only**
- All API calls go directly from your browser to `api.clickup.com`
- No backend server, no data collection, no third-party analytics
- Each user must enter their own API key (it's not shared)

## CORS Note

ClickUp's API supports CORS for browser-based requests, so this works directly from a static site without a proxy.

## Customization

- Edit `styles.css` to change colors/theme
- Edit `app.js` to add more charts or change logic
- Add more List IDs by modifying the fetch logic to pull from multiple lists
