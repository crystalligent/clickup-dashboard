/**
 * Queue Processor (scheduled every 5 minutes)
 * 
 * This scheduled function delegates to run-queue via HTTP.
 * Netlify scheduled functions can't be called via HTTP directly (returns 403),
 * so this just invokes the HTTP-callable run-queue function.
 * 
 * Schedule: Every 5 minutes
 */

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  console.log(`[process-queue] Scheduled run at ${new Date().toISOString()}`);

  const siteUrl = process.env.URL || '';
  if (!siteUrl) {
    console.error('[process-queue] No URL env var set — cannot call run-queue');
    return jsonResponse(500, { error: 'No URL configured' });
  }

  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/run-queue`, {
      headers: { 'X-Sync-Password': process.env.LOGS_PASSWORD || '' },
    });

    const data = await res.json();
    console.log(`[process-queue] run-queue response:`, JSON.stringify(data));
    return jsonResponse(res.status, data);
  } catch (err) {
    console.error('[process-queue] Error calling run-queue:', err.message);
    return jsonResponse(500, { error: err.message });
  }
};
