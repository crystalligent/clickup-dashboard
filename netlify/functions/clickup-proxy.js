// Netlify serverless function that proxies ClickUp API requests
// The CLICKUP_KEY env variable is injected server-side, never exposed to the browser

exports.handler = async (event) => {
    const apiKey = process.env.CLICKUP_KEY;

    if (!apiKey) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'CLICKUP_KEY environment variable not configured' })
        };
    }

    // Get the ClickUp API path from query params
    const path = event.queryStringParameters?.path;

    if (!path) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing "path" query parameter' })
        };
    }

    // Only allow /api/v2/ paths to prevent misuse
    if (!path.startsWith('/api/v2/')) {
        return {
            statusCode: 403,
            body: JSON.stringify({ error: 'Only /api/v2/ paths are allowed' })
        };
    }

    try {
        const url = `https://api.clickup.com${path}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.text();

        return {
            statusCode: response.status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: data
        };
    } catch (err) {
        return {
            statusCode: 502,
            body: JSON.stringify({ error: 'Failed to reach ClickUp API', details: err.message })
        };
    }
};
