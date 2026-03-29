// Vercel Serverless Function: receives tracking events and stores to KV
// Falls back to console logging (visible in Vercel logs) if KV not configured
let kv;
try { kv = require('@vercel/kv').kv; } catch(e) { kv = null; }

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      // sendBeacon sends as text/plain, so parse if needed
      let data = req.body;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch(e) {
          return res.status(400).json({ error: 'Invalid JSON' });
        }
      }

      if (!data || !data.visitorId) {
        return res.status(400).json({ error: 'Missing visitorId' });
      }

      // Add server metadata
      data.serverTime = new Date().toISOString();
      data.ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
      data.userAgent = req.headers['user-agent'] || 'unknown';
      data.referer = req.headers['referer'] || 'direct';

      // Build session summary for the list
      const sessionSummary = {
        visitorId: data.visitorId,
        timestamp: data.serverTime,
        totalTime: data.totalTime || 0,
        maxScroll: data.maxScroll || 0,
        sections: data.sections || {},
        ip: data.ip,
        userAgent: data.userAgent,
        referer: data.referer,
        returning: data.returning || false,
        screenWidth: data.screenWidth,
        screenHeight: data.screenHeight
      };

      // Try KV store first
      try {
        if (kv) {
          // Upsert: use visitorId as key so heartbeats update the same session
          const sessionKey = `session:${data.visitorId}`;
          await kv.set(sessionKey, JSON.stringify(data), { ex: 60 * 60 * 24 * 90 }); // 90 day expiry

          // Check if this visitor already has an entry in the list
          // For simplicity, just push and deduplicate on read
          await kv.lpush('sessions', JSON.stringify(sessionSummary));

          // Trim to last 1000 entries
          await kv.ltrim('sessions', 0, 999);
        }
      } catch (kvErr) {
        // KV not available — no problem, we always log
      }

      // Always log to stdout (visible in Vercel Function logs)
      console.log('DECK_VIEW:', JSON.stringify(sessionSummary));

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Track error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'GET') {
    // Dashboard data endpoint
    const password = req.query.key;
    if (password !== process.env.DECK_ANALYTICS_KEY && password !== 'fanded2026') {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      if (kv) {
        const raw = await kv.lrange('sessions', 0, 199);
        const sessions = raw.map(s => typeof s === 'string' ? JSON.parse(s) : s);

        // Deduplicate: keep latest entry per visitorId
        const seen = {};
        const deduped = [];
        sessions.forEach(function(s) {
          if (!seen[s.visitorId]) {
            seen[s.visitorId] = true;
            deduped.push(s);
          }
        });

        return res.status(200).json({
          sessions: deduped,
          count: deduped.length,
          totalEntries: await kv.llen('sessions')
        });
      } else {
        return res.status(200).json({
          sessions: [],
          note: 'KV not configured. Check Vercel Function logs for DECK_VIEW entries.'
        });
      }
    } catch (err) {
      return res.status(200).json({
        sessions: [],
        note: 'KV error: ' + err.message + '. Check Vercel Function logs for DECK_VIEW entries.'
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
