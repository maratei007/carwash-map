module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const content = String(body?.content || '');
    if (!content) return res.status(400).json({ error: 'No content' });

    const prompt = 'You are helping analyze Russian real estate listings for self-service car wash rental in Moscow.\nExtract data and return ONLY valid JSON without markdown:\n{"title":"...","address":"...","district":null,"metro":null,"area_m2":null,"posts":null,"rent_month":null,"lease_years":null,"has_equipment":null,"access_247":null,"parking":null,"utilities_included":null,"source":"avito","url":null,"comment":"...","red_flags":[],"score":0}\nScore 9-10 ready carwash 4+ posts, 7-8 good 500+m2, 5-6 ok, 3-4 check, 0-2 weak.\nListing text:\n---\n' + content.slice(0,6000) + '\n---';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'API error' });
    const match = data.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'No JSON in response' });
    return res.status(200).json(JSON.parse(match[0]));
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
