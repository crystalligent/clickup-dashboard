# ClickUp Dashboard + GitLab Integration

A Netlify-deployed service that syncs GitLab issues to ClickUp tasks — no execution limits, no credits, runs free on Netlify's generous function tier.

## Architecture

This replaces the Activepieces "GitLab to ClickUp" flow with two Netlify serverless functions:

| Function | Trigger | Purpose |
|----------|---------|---------|
| `gitlab-webhook` | GitLab Issue webhook (POST) | Real-time sync when issues are created/updated |
| `sync-gitlab` | Every 5 minutes (scheduled) + manual GET | Polls GitLab for recently updated issues as a fallback |

No external database or Google Sheets needed — the functions check your ClickUp list directly to determine if a task already exists.

### Flow Logic

```
GitLab Issue Event
  │
  ├─ Filter: only allowed milestones (802, 752, 756)
  │
  ├─ Lookup: search ClickUp list for existing task (by IID prefix in name)
  │
  ├─ If task exists in ClickUp:
  │     ├─ "Released" label    → update status to "Released to Prod"
  │     ├─ "For Release" label → update status to "For release"
  │     └─ Other               → update task name only
  │
  └─ If new task:
        ├─ Milestone 756 → create with status "pending review (qa)" + assignee
        └─ Other         → create with status "Open"
```

## Setup

### 1. Deploy to Netlify

```bash
# From the clickup-dashboard directory
netlify deploy --prod
```

Or connect this repo to Netlify via the dashboard for automatic deploys.

### 2. Set Environment Variables

In **Netlify Dashboard → Site → Environment Variables**, add:

| Variable | Description |
|----------|-------------|
| `CLICKUP_KEY` | ClickUp API token (pk_...) |
| `CLICKUP_LIST_ID` | List ID where tasks are created and searched |
| `DEFAULT_ASSIGNEE_ID` | Assignee for QA tasks (optional) |
| `GITLAB_WEBHOOK_SECRET` | Secret to validate webhook requests |
| `GITLAB_URL` | GitLab base URL (e.g. https://tools.iripple.com) |
| `GITLAB_TOKEN` | GitLab personal access token (read_api scope) |
| `GITLAB_PROJECT_ID` | Project ID to poll |
| `ALLOWED_MILESTONES` | Comma-separated milestone IDs (e.g. 802,752,756) |
| `QA_MILESTONE_ID` | Milestone ID for "pending review (qa)" status |

### 3. Configure GitLab Webhook

In your GitLab project → Settings → Webhooks:

- **URL**: `https://your-site.netlify.app/webhook/gitlab`
- **Secret token**: same value as `GITLAB_WEBHOOK_SECRET`
- **Trigger**: ✅ Issues events
- **SSL verification**: ✅ Enable

## Endpoints

| URL | Method | Purpose |
|-----|--------|---------|
| `/webhook/gitlab` | POST | GitLab webhook receiver |
| `/api/sync` | GET | Manual sync trigger |
| `/api/logs` | GET | Retrieve sync run history |

## Pages

| Page | Description |
|------|-------------|
| `index.html` | Main ClickUp task dashboard |
| `progress.html` | Team progress tracker |
| `developers.html` | Developer task view |
| `logs.html` | Sync monitoring — run history, errors, and stats |

## Netlify Free Tier Limits

- **Functions**: 125K invocations/month, 100 hours compute
- **Scheduled functions**: included in the above
- At 5-min intervals = ~8,640 scheduled runs/month (well within limits)

Compare to Activepieces free: 100 runs total. This setup gives you effectively **unlimited** runs.

## Local Development

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Create a .env file from the example
cp .env.example .env
# Fill in your actual values

# Run locally
netlify dev
```

Test the webhook locally:
```bash
curl -X POST http://localhost:8888/webhook/gitlab \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Token: core-ripple" \
  -d @../gitlab-update.json
```
