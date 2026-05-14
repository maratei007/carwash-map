const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAP_URL = process.env.MAP_URL || 'https://carwash-map.vercel.app';
const TELEGRAM_API = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN;

async function sendMessage(chatId, text) {
  const body = Buffer.from(JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }), 'utf-8');
  await fetch(TELEGRAM_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: body,
  });
}

async function fetchPageText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
    const html = await resp.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  } catch(e) { return null; }
}

async function parseWithClaude(content, url) {
  const messages = [{
    role: 'user',
    content: [
      'Analyze this Russian real estate listing for self-service car wash rental in Moscow.',
      'Return ONLY valid JSON, no markdown:',
      '{"title":"short name","address":"full address","district":null,"metro":null,"area_m2":null,"posts":null,"rent_month":null,"lease_years":null,"has_equipment":null,"access_247":null,"parking":null,"utilities_included":null,"source":"avito","url":"' + (url || '') + '","comment":"1-2 sentences","red_flags":[],"score":0}',
      'red_flags options: lease_under_5_years, area_under_200, posts_under_3, no_parking, no_access_247, needs_renovation, industrial_zone',
      'score: 9-10 ready carwash 4+posts, 7-8 good 500m2+, 5-6 ok, 3-4 check, 0-2 weak',
      'LISTING TEXT:',
      content.slice(0, 5000),
    ].join('\n'),
  }];

  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: messages,
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf-8');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: body,
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error && data.error.message ? data.error.message : 'Claude API error');
  const match = data.content[0].text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude response');
  return JSON.parse(match[0]);
}

async function geocode(address) {
  try {
    const q = encodeURIComponent('Moscow, ' + address);
    const resp = await fetch(
      'https://geocode-maps.yandex.ru/1.x/?apikey=f30a06ff-8f3e-45d8-8408-0d663acdbc1b&geocode=' + q + '&format=json&results=1'
    );
    const data = await resp.json();
    const pos = data &&
      data.response &&
      data.response.GeoObjectCollection &&
      data.response.GeoObjectCollection.featureMember &&
      data.response.GeoObjectCollection.featureMember[0] &&
      data.response.GeoObjectCollection.featureMember[0].GeoObject &&
      data.response.GeoObjectCollection.featureMember[0].GeoObject.Point &&
      data.response.GeoObjectCollection.featureMember[0].GeoObject.Point.pos;
    if (pos) {
      const parts = pos.split(' ');
      return { lat: parseFloat(parts[1]), lon: parseFloat(parts[0]) };
    }
  } catch(e) {}
  return { lat: null, lon: null };
}

async function saveListing(parsed, addedBy) {
  const coords = parsed.address ? await geocode(parsed.address) : { lat: null, lon: null };

  const listing = {
    source: 'bot',
    url: parsed.url || null,
    title: parsed.title || parsed.address || 'New listing',
    address: parsed.address || '',
    lat: coords.lat,
    lon: coords.lon,
    district: parsed.district || null,
    metro: parsed.metro || null,
    area_m2: parsed.area_m2 || null,
    posts: parsed.posts || null,
    rent_month: parsed.rent_month || null,
    lease_years: parsed.lease_years || null,
    has_equipment: parsed.has_equipment !== undefined ? parsed.has_equipment : null,
    access_247: parsed.access_247 !== undefined ? parsed.access_247 : null,
    parking: parsed.parking !== undefined ? parsed.parking : null,
    utilities_included: parsed.utilities_included !== undefined ? parsed.utilities_included : null,
    comment: parsed.comment || null,
    red_flags: parsed.red_flags || [],
    score: parsed.score || 0,
    status: 'new',
  };

  const body = Buffer.from(JSON.stringify(listing), 'utf-8');

  const resp = await fetch(SUPABASE_URL + '/rest/v1/listings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=representation',
    },
    body: body,
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error('Supabase error: ' + JSON.stringify(data));
  const saved = Array.isArray(data) ? data[0] : data;

  // Log activity
  try {
    const actBody = Buffer.from(JSON.stringify({
      type: 'bot',
      user_name: addedBy,
      description: 'added via Telegram: "' + (parsed.address || 'listing') + '"',
      listing_id: saved && saved.id ? saved.id : null,
    }), 'utf-8');
    await fetch(SUPABASE_URL + '/rest/v1/activity', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
      },
      body: actBody,
    });
  } catch(e) {}

  return saved;
}

function buildResultMessage(parsed) {
  const scoreEmoji = parsed.score >= 7 ? '\uD83D\uDFE2' : parsed.score >= 3 ? '\uD83D\uDFE1' : '\u26AA';
  const rent = parsed.rent_month ? Math.round(parsed.rent_month / 1000) + 'k RUB/mo' : 'price unknown';
  const area = parsed.area_m2 ? parsed.area_m2 + ' m2' : '';
  const posts = parsed.posts ? parsed.posts + ' posts' : '';

  return scoreEmoji + ' <b>Score: ' + parsed.score + '/10</b> — added to map!\n\n' +
    '\uD83D\uDCCD <b>' + (parsed.address || '—') + '</b>\n' +
    (parsed.metro ? '\uD83D\DE87 ' + parsed.metro + '\n' : '') +
    [area, posts, rent].filter(Boolean).join(' · ') + '\n\n' +
    (parsed.comment || '') + '\n\n' +
    '\uD83D\DDFB <a href="' + MAP_URL + '">Open map</a>' +
    (parsed.url ? '\n\uD83D\uDD17 <a href="' + parsed.url + '">Listing</a>' : '');
}

const HELP_TEXT = '\uD83D\uDCCB <b>How to add a listing:</b>\n\n' +
  '<b>Method 1 — send a link</b>\n' +
  '1. Find a listing on Avito or Cian\n' +
  '2. Copy the URL\n' +
  '3. Send it to me\n\n' +
  '<b>Method 2 — send page text (more reliable)</b>\n' +
  '1. Open the listing in browser\n' +
  '2. Select all text (Ctrl+A / Cmd+A)\n' +
  '3. Copy (Ctrl+C / Cmd+C)\n' +
  '4. Paste and send to me\n\n' +
  '<b>What I extract automatically:</b>\n' +
  '• Address and coordinates\n' +
  '• Area, number of posts\n' +
  '• Rent and lease term\n' +
  '• Equipment availability\n' +
  '• District and metro\n' +
  '• Attractiveness score (0-10)\n\n' +
  '\uD83D\DDFB <a href="' + MAP_URL + '">Open map</a>\n\n' +
  'Commands: /start /help';

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, status: 'bot is running' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const update = req.body;
    const message = update && update.message;
    if (!message) return res.status(200).end();

    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const firstName = message.from && message.from.first_name ? message.from.first_name : '';
    const lastName = message.from && message.from.last_name ? message.from.last_name : '';
    const userName = [firstName, lastName].filter(Boolean).join(' ') || 'User';

    if (text === '/start') {
      await sendMessage(chatId, 'Hello, ' + userName + '!\n\nI add rental listings for self-service car washes to the team map.\n\n' + HELP_TEXT);
      return res.status(200).end();
    }

    if (text === '/help') {
      await sendMessage(chatId, HELP_TEXT);
      return res.status(200).end();
    }

    const urlMatch = text.match(/https?:\/\/[^\s]+/);

    if (urlMatch) {
      const url = urlMatch[0];
      await sendMessage(chatId, '\u23F3 Reading listing...');
      const pageText = await fetchPageText(url);

      if (!pageText || pageText.length < 200) {
        await sendMessage(chatId,
          '\u26A0\uFE0F Could not read the page — Avito/Cian blocked the request.\n\n' +
          '<b>Try Method 2:</b>\n' +
          '1. Open the listing in browser\n' +
          '2. Select all text (Cmd+A)\n' +
          '3. Copy (Cmd+C)\n' +
          '4. Send the text to me'
        );
        return res.status(200).end();
      }

      await sendMessage(chatId, '\uD83E\uDD16 Analyzing with Claude AI...');
      const parsed = await parseWithClaude(pageText, url);
      await saveListing(parsed, userName);
      await sendMessage(chatId, buildResultMessage(parsed));
      return res.status(200).end();
    }

    if (text.length > 200) {
      await sendMessage(chatId, '\uD83E\uDD16 Analyzing text with Claude AI...');
      const urlInText = text.match(/https?:\/\/(?:www\.)?(?:avito|cian)\.ru\/[^\s]*/);
      const parsed = await parseWithClaude(text, urlInText ? urlInText[0] : '');
      await saveListing(parsed, userName);
      await sendMessage(chatId, buildResultMessage(parsed));
      return res.status(200).end();
    }

    await sendMessage(chatId, 'Send me a listing URL or paste the page text.\n\n/help for instructions');

  } catch(e) {
    console.error('Bot error:', e.message);
    const chatId = req.body && req.body.message && req.body.message.chat ? req.body.message.chat.id : null;
    if (chatId) {
      await sendMessage(chatId, '\u274C Error: ' + e.message + '\n\nTry sending the page text instead of the URL.');
    }
  }

  return res.status(200).end();
};
