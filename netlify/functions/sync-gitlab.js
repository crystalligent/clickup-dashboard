/**
 * Scheduled GitLab Issue Fetcher (every 30 minutes)
 * 
 * Delegates to sync-trigger which handles fetching from GitLab,
 * deduplication, and queuing. This avoids redundant GitLab API calls
 * since sync-trigger manages its own last-sync timestamp via Blobs.
 * 
 * Schedule: Every 30 minutes
 */

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  console.log(`[sync-gitlab] Triggering sync at ${new Date().toISOString()}`);

  const siteUrl = process.env.URL || '';
  if (!siteUrl) {
    console.error('[sync-gitlab] No URL env var set — cannot call sync-trigger');
    return jsonResponse(500, { error: 'No URL configured' });
  }

  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/sync-trigger`, {
      headers: { 'X-Sync-Password': process.env.LOGS_PASSWORD || '' },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[sync-gitlab] sync-trigger returned ${res.status}: ${text}`);
      return jsonResponse(res.status, { error: `sync-trigger ${res.status}` });
    }

    const data = await res.json();
    console.log(`[sync-gitlab] sync-trigger response: ${JSON.stringify(data)}`);
    return jsonResponse(200, { delegated: true, ...data });
  } catch (err) {
    console.error('[sync-gitlab] Error calling sync-trigger:', err.message);
    return jsonResponse(500, { error: err.message });
  }
};
