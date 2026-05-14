// @ts-check
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const rawContent = body && body.content ? String(body.content) : '';
    if (!rawContent) return res.status(400).json({ error: 'No content provided' });

    const content = rawContent.slice(0, 6000);

    const prompt = [
      'You are helping analyze Russian real estate listings for self-service car wash rental in Moscow.',
      'Extract data from the listing text below and return ONLY valid JSON without markdown or explanations.',
      '',
      'Listing text:',
      '---',
      content,
      '---',
      '',
      'Return this exact JSON structure (use null for unknown fields):',
      '{',
      '  "title": "short object name in Russian",',
      '  "address": "full Moscow address in Russian",',
      '  "district": "district and administrative okrug or null",',
      '  "metro": "nearest metro station or null",',
      '  "area_m2": number or null,',
      '  "posts": number of car wash posts or null,',
      '  "rent_month": monthly rent in rubles as number or null,',
      '  "lease_years": lease term in years as number or null,',
      '  "has_equipment": true/false/null,',
      '  "access_247": true/false/null,',
      '  "parking": true/false/null,',
      '  "utilities_included": true/false/null,',
      '  "source": "avito" or "cian" or "manual",',
      '  "url": "listing url or null",',
      '  "comment": "1-2 sentence summary in Russian",',
      '  "red_flags": ["array of: lease_under_5_years, area_under_200, posts_under_3, no_parking, no_access_247, needs_renovation, industrial_zone, low_ceiling, forbidden_use"],',
      '  "score": number 0-10',
      '}',
      '',
      'Score guide: 9-10 ready car wash 4+ posts in residential area, 7-8 good space 500+m2, 5-6 promising, 3-4 needs verification, 0-2 weak.'
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'API error' });
    }

    const text = data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse Claude response' });

    return res.status(200).json(JSON.parse(jsonMatch[0]));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
