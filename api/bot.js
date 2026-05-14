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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Accept-Charset': 'utf-8',
      },
    });
    // Read as ArrayBuffer then decode as UTF-8 to avoid ByteString issues
    const arrayBuffer = await resp.arrayBuffer();
    const decoder = new TextDecoder('utf-8');
    const html = decoder.decode(arrayBuffer);
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  } catch(e) {
    console.error('fetchPageText error:', e.message);
    return null;
  }
}

async function parseWithClaude(content, url) {
  const userContent = [
    'Analyze this Russian real estate listing for self-service car wash rental in Moscow.',
    'Return ONLY valid JSON, no markdown, no explanation:',
    '{"title":"short name","address":"full address","district":null,"metro":null,"area_m2":null,"posts":null,"rent_month":null,"lease_years":null,"has_equipment":null,"access_247":null,"parking":null,"utilities_included":null,"source":"avito","url":"URL_PLACEHOLDER","comment":"1-2 sentences","red_flags":[],"score":0}',
    'Replace URL_PLACEHOLDER with: ' + (url || ''),
    'red_flags: lease_under_5_years, area_under_200, posts_under_3, no_parking, no_access_247, needs_renovation, industrial_zone',
    'score: 9-10 ready carwash 4+posts, 7-8 good 500m2+, 5-6 ok, 3-4 check, 0-2 weak',
    'LISTING:',
    content.slice(0, 5000),
  ].join('\n');

  const payload = { model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: userContent }] };
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: body,
  });

  const arrayBuffer = await resp.arrayBuffer();
  const data = JSON.parse(new TextDecoder('utf-8').decode(arrayBuffer));
  if (!resp.ok) throw new Error(data.error && data.error.message ? data.error.message : 'Claude API error');
  const match = data.content[0].text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude response');
  return JSON.parse(match[0]);
}

async function geocode(address) {
  try {
    const q = encodeURIComponent(address + ', Moscow');
    const resp = await fetch('https://geocode-maps.yandex.ru/1.x/?apikey=f30a06ff-8f3e-45d8-8408-0d663acdbc1b&geocode=' + q + '&format=json&results=1');
    const arrayBuffer = await resp.arrayBuffer();
    const data = JSON.parse(new TextDecoder('utf-8').decode(arrayBuffer));
    const members = data && data.response && data.response.GeoObjectCollection && data.response.GeoObjectCollection.featureMember;
    if (members && members.length > 0) {
      const pos = members[0].GeoObject && members[0].GeoObject.Point && members[0].GeoObject.Point.pos;
      if (pos) {
        const parts = pos.split(' ');
        return { lat: parseFloat(parts[1]), lon: parseFloat(parts[0]) };
      }
    }
  } catch(e) {}
  return { lat: null, lon: null };
}

async function saveListing(parsed, addedBy) {
  const coords = parsed.address ? await geocode(parsed.address) : { lat: null, lon: null };
  const listing = {
    source: 'bot', url: parsed.url || null,
    title: parsed.title || parsed.address || 'Listing',
    address: parsed.address || '',
    lat: coords.lat, lon: coords.lon,
    district: parsed.district || null, metro: parsed.metro || null,
    area_m2: parsed.area_m2 || null, posts: parsed.posts || null,
    rent_month: parsed.rent_month || null, lease_years: parsed.lease_years || null,
    has_equipment: parsed.has_equipment !== undefined ? parsed.has_equipment : null,
    access_247: parsed.access_247 !== undefined ? parsed.access_247 : null,
    parking: parsed.parking !== undefined ? parsed.parking : null,
    utilities_included: parsed.utilities_included !== undefined ? parsed.utilities_included : null,
    comment: parsed.comment || null,
    red_flags: parsed.red_flags || [],
    score: parsed.score || 0, status: 'new',
  };

  const body = Buffer.from(JSON.stringify(listing), 'utf-8');
  const resp = await fetch(SUPABASE_URL + '/rest/v1/listings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Prefer': 'return=representation' },
    body: body,
  });

  const ab = await resp.arrayBuffer();
  const data = JSON.parse(new TextDecoder('utf-8').decode(ab));
  if (!resp.ok) throw new Error('Supabase: ' + JSON.stringify(data));
  const saved = Array.isArray(data) ? data[0] : data;

  // Activity log
  try {
    const actBody = Buffer.from(JSON.stringify({ type: 'bot', user_name: addedBy, description: 'added via Telegram: ' + (parsed.address || 'listing'), listing_id: saved && saved.id ? saved.id : null }), 'utf-8');
    await fetch(SUPABASE_URL + '/rest/v1/activity', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, body: actBody });
  } catch(e) {}

  return saved;
}

function buildResult(parsed) {
  const e = parsed.score >= 7 ? '\uD83D\uDFE2' : parsed.score >= 3 ? '\uD83D\uDFE1' : '\u26AA';
  const rent = parsed.rent_month ? Math.round(parsed.rent_month / 1000) + 'k RUB/mo' : '';
  const area = parsed.area_m2 ? parsed.area_m2 + 'm\u00B2' : '';
  const posts = parsed.posts ? parsed.posts + ' posts' : '';
  const parts = [area, posts, rent].filter(Boolean).join(' \u00B7 ');
  return e + ' <b>Score: ' + parsed.score + '/10</b> \u2014 added!\n\n\uD83D\uDCCD <b>' + (parsed.address || '?') + '</b>\n' +
    (parsed.metro ? '\uD83D\DE87 ' + parsed.metro + '\n' : '') +
    (parts ? parts + '\n' : '') +
    (parsed.comment ? '\n' + parsed.comment + '\n' : '') +
    '\n\uD83D\DDFB <a href="' + MAP_URL + '">Open map</a>' +
    (parsed.url ? '  \uD83D\uDD17 <a href="' + parsed.url + '">Listing</a>' : '');
}

const HELP = '\uD83D\uDCCB <b>How to add a listing:</b>\n\n<b>Method 1 \u2014 send a link</b>\nFind a listing on Avito or Cian, copy the URL, send to me.\n\n<b>Method 2 \u2014 send page text (more reliable)</b>\nOpen listing in browser \u2192 Cmd+A \u2192 Cmd+C \u2192 paste here.\n\n\uD83D\DDFB <a href="' + MAP_URL + '">Open map</a>';

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, status: 'bot is running' });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const msg = req.body && req.body.message;
    if (!msg) return res.status(200).end();

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const name = [(msg.from && msg.from.first_name) || '', (msg.from && msg.from.last_name) || ''].filter(Boolean).join(' ') || 'User';

    if (text === '/start') { await sendMessage(chatId, 'Hello ' + name + '!\n\n' + HELP); return res.status(200).end(); }
    if (text === '/help') { await sendMessage(chatId, HELP); return res.status(200).end(); }

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      await sendMessage(chatId, '\u23F3 Reading listing...');
      const pageText = await fetchPageText(url);
      if (!pageText || pageText.length < 200) {
        await sendMessage(chatId, '\u26A0\uFE0F Could not read page (blocked).\n\nTry Method 2:\nOpen in browser \u2192 Cmd+A \u2192 Cmd+C \u2192 paste here.');
        return res.status(200).end();
      }
      await sendMessage(chatId, '\uD83E\uDD16 Analyzing with Claude AI...');
      const parsed = await parseWithClaude(pageText, url);
      await saveListing(parsed, name);
      await sendMessage(chatId, buildResult(parsed));
      return res.status(200).end();
    }

    if (text.length > 200) {
      await sendMessage(chatId, '\uD83E\uDD16 Analyzing with Claude AI...');
      const urlInText = text.match(/https?:\/\/(?:www\.)?(?:avito|cian)\.ru\/[^\s]*/);
      const parsed = await parseWithClaude(text, urlInText ? urlInText[0] : '');
      await saveListing(parsed, name);
      await sendMessage(chatId, buildResult(parsed));
      return res.status(200).end();
    }

    await sendMessage(chatId, 'Send a listing URL or paste the page text.\n\n/help for instructions');
  } catch(e) {
    console.error('Bot error:', e.message);
    const chatId = req.body && req.body.message && req.body.message.chat && req.body.message.chat.id;
    if (chatId) await sendMessage(chatId, '\u274C Error: ' + e.message);
  }
  return res.status(200).end();
};
