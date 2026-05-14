export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    let body = '';
    if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
    } else {
      try { body = JSON.parse(req.body); } catch(e) { body = {}; }
    }
    const content = body.content;
    if (!content) return res.status(400).json({ error: 'No content provided' });

    const prompt = `Ты помогаешь анализировать объявления об аренде помещений под автомойку самообслуживания в Москве.

Вот текст объявления:
---
${content.slice(0, 6000)}
---

Извлеки данные и верни ТОЛЬКО валидный JSON без markdown и пояснений:
{
  "title": "краткое название объекта",
  "address": "полный адрес в Москве",
  "district": "район и округ или null",
  "metro": "ближайшее метро или null",
  "area_m2": число или null,
  "posts": количество постов мойки или null,
  "rent_month": арендная плата в рублях в месяц (число) или null,
  "lease_years": срок аренды в годах или null,
  "has_equipment": true/false/null,
  "access_247": true/false/null,
  "parking": true/false/null,
  "utilities_included": true/false/null,
  "source": "avito" или "cian" или "manual",
  "url": "ссылка на объявление или null",
  "comment": "краткое описание 1-2 предложения",
  "red_flags": ["список красных флагов из: lease_under_5_years, area_under_200, posts_under_3, no_parking, no_access_247, needs_renovation, industrial_zone, low_ceiling, forbidden_use"],
  "score": число от 0 до 10
}

Score: 9-10 готовая мойка 4+ поста в жилом районе, 7-8 хорошее помещение 500+м², 5-6 перспективное, 3-4 под вопросом, 0-2 слабое.`;

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
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });

    const text = data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse response' });

    return res.status(200).json(JSON.parse(jsonMatch[0]));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
