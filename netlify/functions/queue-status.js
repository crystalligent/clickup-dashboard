/**
 * Queue Status API — Returns current queue contents.
 * 
 * GET /.netlify/functions/queue-status → returns queue items
 * DELETE /.netlify/functions/queue-status → clears the queue
 */

const { getQueue, saveQueue, getQueueSize } = require('./utils/queue');

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  // Password protection
  const requiredPassword = process.env.LOGS_PASSWORD;
  if (requiredPassword) {
    const provided = event.headers['x-sync-password'] || '';
    if (provided !== requiredPassword) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
  }

  // POST: enqueue items (called by sync-trigger)
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      const issues = body.issues || [];
      if (issues.length === 0) return jsonResponse(400, { error: 'No issues provided' });

      const queue = await getQueue();
      const existingMap = new Map(queue.map((item) => [String(item.iid), item]));

      for (const issue of issues) {
        existingMap.set(String(issue.iid), issue);
      }

      const newQueue = Array.from(existingMap.values());
      await saveQueue(newQueue);

      return jsonResponse(200, { queued: issues.length, queueSize: newQueue.length });
    } catch (err) {
      return jsonResponse(500, { error: err.message });
    }
  }

  if (event.httpMethod === 'DELETE') {
    await saveQueue([]);
    return jsonResponse(200, { cleared: true });
  }

  const queue = await getQueue();
  return jsonResponse(200, { size: queue.length, items: queue });
};
