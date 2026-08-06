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

  if (event.httpMethod === 'DELETE') {
    await saveQueue([]);
    return jsonResponse(200, { cleared: true });
  }

  const queue = await getQueue();
  return jsonResponse(200, { size: queue.length, items: queue });
};
