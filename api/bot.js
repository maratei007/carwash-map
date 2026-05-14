const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAP_URL = process.env.MAP_URL || 'https://carwash-map.vercel.app';
const VERSION = 'v2.5';
const TELEGRAM_API = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN;

async function sendMessage(chatId, text) {
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  const resp = await fetch(TELEGRAM_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const ab = await resp.arrayBuffer();
  return JSON.parse(new TextDecoder('utf-8').decode(ab));
}

async function fetchPageText(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru-RU,ru;q=0.9' },
    });
    const ab = await resp.arrayBuffer();
    const html = new TextDecoder('utf-8').decode(ab);
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  } catch(e) {
    return null;
  }
}

async function parseWithClaude(content, url) {
  const userContent = 'Analyze this Russian real estate listing for self-service car wash in Moscow.\n' +
    'Return ONLY valid JSON:\n' +
    '{"title":"name","address":"address","district":null,"metro":null,"area_m2":null,"posts":null,"rent_month":null,"lease_years":null,"has_equipment":null,"access_247":null,"parking":null,"utilities_included":null,"source":"avito","url":"' + (url||'') + '","comment":"summary","red_flags":[],"score":5}\n' +
    'score 9-10=ready carwash, 7-8=good space, 5-6=ok, 3-4=check, 0-2=weak\n' +
    'red_flags: lease_under_5_years area_under_200 posts_under_3 no_parking industrial_zone needs_renovation\n' +
    'LISTING:\n' + content.slice(0, 5000);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const ab = await resp.arrayBuffer();
  const data = JSON.parse(new TextDecoder('utf-8').decode(ab));
  if (!resp.ok) throw new Error(data.error ? data.error.message : 'Claude error');
  const match = data.content[0].text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON from Claude');
  return JSON.parse(match[0]);
}

async function geocode(address) {
  try {
    const q = encodeURIComponent(address + ', Moscow');
    const resp = await fetch('https://geocode-maps.yandex.ru/1.x/?apikey=f30a06ff-8f3e-45d8-8408-0d663acdbc1b&geocode=' + q + '&format=json&results=1');
    const ab = await resp.arrayBuffer();
    const data = JSON.parse(new TextDecoder('utf-8').decode(ab));
    const m = data && data.response && data.response.GeoObjectCollection && data.response.GeoObjectCollection.featureMember;
    if (m && m[0] && m[0].GeoObject && m[0].GeoObject.Point) {
      const parts = m[0].GeoObject.Point.pos.split(' ');
      return { lat: parseFloat(parts[1]), lon: parseFloat(parts[0]) };
    }
  } catch(e) {}
  return { lat: null, lon: null };
}

async function saveListing(parsed, addedBy) {
  const coords = parsed.address ? await geocode(parsed.address) : { lat: null, lon: null };
  const listing = {
    source: 'bot', url: parsed.url || null,
    title: parsed.title || 'Listing', address: parsed.address || '',
    lat: coords.lat, lon: coords.lon,
    district: parsed.district || null, metro: parsed.metro || null,
    area_m2: parsed.area_m2 || null, posts: parsed.posts || null,
    rent_month: parsed.rent_month || null, lease_years: parsed.lease_years || null,
    has_equipment: parsed.has_equipment !== undefined ? parsed.has_equipment : null,
    access_247: parsed.access_247 !== undefined ? parsed.access_247 : null,
    parking: parsed.parking !== undefined ? parsed.parking : null,
    utilities_included: parsed.utilities_included !== undefined ? parsed.utilities_included : null,
    comment: parsed.comment || null, red_flags: parsed.red_flags || [],
    score: parsed.score || 0, status: 'new',
  };
  const resp = await fetch(SUPABASE_URL + '/rest/v1/listings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Prefer': 'return=representation' },
    body: JSON.stringify(listing),
  });
  const ab = await resp.arrayBuffer();
  const data = JSON.parse(new TextDecoder('utf-8').decode(ab));
  if (!resp.ok) throw new Error('Supabase: ' + JSON.stringify(data));
  const saved = Array.isArray(data) ? data[0] : data;
  try {
    await fetch(SUPABASE_URL + '/rest/v1/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ type: 'bot', user_name: addedBy, description: 'added via Telegram: ' + (parsed.address || 'listing'), listing_id: saved && saved.id ? saved.id : null }),
    });
  } catch(e) {}
  return saved;
}

function scoreEmoji(score) { return score >= 7 ? '[TOP]' : score >= 3 ? '[OK]' : '[WEAK]'; }

function buildResult(parsed) {
  const rent = parsed.rent_month ? Math.round(parsed.rent_month / 1000) + 'k RUB/mo' : '';
  const area = parsed.area_m2 ? parsed.area_m2 + 'm2' : '';
  const posts = parsed.posts ? parsed.posts + ' posts' : '';
  const parts = [area, posts, rent].filter(Boolean).join(' / ');
  const flags = parsed.red_flags && parsed.red_flags.length ? '\nFlags: ' + parsed.red_flags.join(', ') : '';
  return scoreEmoji(parsed.score) + ' Score: ' + parsed.score + '/10 - added to map!\n\n' +
    'Address: ' + (parsed.address || '?') + '\n' +
    (parsed.metro ? 'Metro: ' + parsed.metro + '\n' : '') +
    (parts ? parts + '\n' : '') +
    (parsed.comment ? '\n' + parsed.comment : '') +
    flags + '\n\n' +
    'Map: ' + MAP_URL + '\n' +
    (parsed.url ? 'Listing: ' + parsed.url : '');
}

const HELP_TEXT = 'How to add a listing [' + VERSION + ']:\n\n' +
  'Method 1 - send a URL:\nFind listing on Avito/Cian, copy URL, send to me.\n\n' +
  'Method 2 - send page text (more reliable):\nOpen listing, select all (Cmd+A), copy (Cmd+C), paste here.\n\n' +
  'Map: ' + MAP_URL;

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, version: VERSION });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const msg = req.body && req.body.message;
    if (!msg) return res.status(200).end();

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const name = [(msg.from && msg.from.first_name) || '', (msg.from && msg.from.last_name) || ''].filter(Boolean).join(' ') || 'User';

    if (text === '/start') {
      await sendMessage(chatId, 'Hello ' + name + '!\n\n' + HELP_TEXT);
      return res.status(200).end();
    }
    if (text === '/help') {
      await sendMessage(chatId, HELP_TEXT);
      return res.status(200).end();
    }

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      await sendMessage(chatId, 'Reading listing...');
      const pageText = await fetchPageText(url);
      if (!pageText || pageText.length < 200) {
        await sendMessage(chatId, 'Could not read page (blocked by site).\n\nTry Method 2: open in browser, select all (Cmd+A), copy, paste here.');
        return res.status(200).end();
      }
      await sendMessage(chatId, 'Analyzing with Claude AI...');
      const parsed = await parseWithClaude(pageText, url);
      await saveListing(parsed, name);
      await sendMessage(chatId, buildResult(parsed));
      return res.status(200).end();
    }

    if (text.length > 200) {
      await sendMessage(chatId, 'Analyzing with Claude AI...');
      const urlInText = text.match(/https?:\/\/(?:www\.)?(?:avito|cian)\.ru\/[^\s]*/);
      const parsed = await parseWithClaude(text, urlInText ? urlInText[0] : '');
      await saveListing(parsed, name);
      await sendMessage(chatId, buildResult(parsed));
      return res.status(200).end();
    }

    await sendMessage(chatId, 'Send a listing URL or paste the page text.\n\n/help for instructions [' + VERSION + ']');

  } catch(e) {
    console.error('Bot error:', e.message);
    const chatId = req.body && req.body.message && req.body.message.chat && req.body.message.chat.id;
    if (chatId) {
      try { await sendMessage(chatId, 'Error: ' + e.message); } catch(e2) {}
    }
  }
  return res.status(200).end();
};
