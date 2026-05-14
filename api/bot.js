const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAP_URL = process.env.MAP_URL || 'https://carwash-map.vercel.app';
const VERSION = 'v2.6';
const TELEGRAM_API = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN;

const MSG = {
  reading: 'Читаю объявление...',
  analyzing: 'Анализирую через Claude AI...',
  blocked: 'Не удалось прочитать страницу — Авито/Циан заблокировали запрос.\n\nИспользуй Способ 2:\nОткрой в браузере, выдели всё (Cmd+A), скопируй (Cmd+C), вставь сюда.',
  default: 'Отправь ссылку на объявление или вставь текст страницы.\n\n/help — инструкция',
};

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
  } catch(e) { return null; }
}

async function parseWithClaude(content, url) {
  const prompt = [
    'Analyze this Russian real estate listing for self-service car wash rental in Moscow.',
    'Return ONLY valid JSON, no markdown:',
    '{"title":"название","address":"адрес","district":null,"metro":null,"area_m2":null,"posts":null,"rent_month":null,"lease_years":null,"has_equipment":null,"access_247":null,"parking":null,"utilities_included":null,"source":"avito","url":"' + (url||'') + '","comment":"краткое описание 1-2 предложения на русском","red_flags":[],"score":5}',
    'score: 9-10 готовая мойка 4+ поста, 7-8 хорошее помещение 500м2+, 5-6 перспективно, 3-4 под вопросом, 0-2 слабое',
    'red_flags: lease_under_5_years area_under_200 posts_under_3 no_parking industrial_zone needs_renovation low_ceiling',
    'LISTING:',
    content.slice(0, 5000),
  ].join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
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
    const q = encodeURIComponent(address + ', Москва');
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
    title: parsed.title || 'Объявление', address: parsed.address || '',
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
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=representation',
    },
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
      body: JSON.stringify({
        type: 'bot',
        user_name: addedBy,
        description: 'добавил через Telegram: ' + (parsed.address || 'объявление'),
        listing_id: saved && saved.id ? saved.id : null,
      }),
    });
  } catch(e) {}
  return saved;
}

function scoreLabel(score) {
  return score >= 7 ? '[ТОП]' : score >= 3 ? '[ОК]' : '[СЛАБО]';
}

function buildResult(parsed) {
  const rent = parsed.rent_month ? Math.round(parsed.rent_month / 1000) + 'к руб/мес' : '';
  const area = parsed.area_m2 ? parsed.area_m2 + ' м2' : '';
  const posts = parsed.posts ? parsed.posts + ' поста' : '';
  const parts = [area, posts, rent].filter(Boolean).join(' / ');
  const flags = parsed.red_flags && parsed.red_flags.length ? '\nФлаги: ' + parsed.red_flags.join(', ') : '';

  const lines = [
    scoreLabel(parsed.score) + ' Оценка: ' + parsed.score + '/10 — добавлено на карту!',
    '',
    'Адрес: ' + (parsed.address || '?'),
    parsed.metro ? 'Метро: ' + parsed.metro : '',
    parsed.district ? 'Район: ' + parsed.district : '',
    parts || '',
    '',
    parsed.comment || '',
    flags,
    '',
    'Карта: ' + MAP_URL,
    parsed.url ? 'Объявление: ' + parsed.url : '',
  ];
  return lines.filter(function(l) { return l !== null && l !== undefined; }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildHelp(name) {
  const greeting = name ? 'Привет, ' + name + '!\n\n' : '';
  return greeting +
    'Я добавляю объявления об аренде помещений под автомойку на карту команды.\n\n' +
    'Как добавить объявление [' + VERSION + ']:\n\n' +
    'Способ 1 — прислать ссылку:\n' +
    'Найди объявление на Авито/Циан, скопируй ссылку, отправь мне.\n\n' +
    'Способ 2 — прислать текст страницы (надёжнее):\n' +
    'Открой объявление в браузере, выдели всё (Cmd+A), скопируй (Cmd+C), вставь сюда.\n\n' +
    'Карта: ' + MAP_URL;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, version: VERSION });
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const msg = req.body && req.body.message;
    if (!msg) return res.status(200).end();

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const firstName = (msg.from && msg.from.first_name) || '';
    const lastName = (msg.from && msg.from.last_name) || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || '';

    if (text === '/start') {
      await sendMessage(chatId, buildHelp(name));
      return res.status(200).end();
    }
    if (text === '/help') {
      await sendMessage(chatId, buildHelp(''));
      return res.status(200).end();
    }

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      await sendMessage(chatId, MSG.reading);
      const pageText = await fetchPageText(url);
      if (!pageText || pageText.length < 200) {
        await sendMessage(chatId, MSG.blocked);
        return res.status(200).end();
      }
      await sendMessage(chatId, MSG.analyzing);
      const parsed = await parseWithClaude(pageText, url);
      await saveListing(parsed, name || 'Telegram');
      await sendMessage(chatId, buildResult(parsed));
      return res.status(200).end();
    }

    if (text.length > 200) {
      await sendMessage(chatId, MSG.analyzing);
      const urlInText = text.match(/https?:\/\/(?:www\.)?(?:avito|cian)\.ru\/[^\s]*/);
      const parsed = await parseWithClaude(text, urlInText ? urlInText[0] : '');
      await saveListing(parsed, name || 'Telegram');
      await sendMessage(chatId, buildResult(parsed));
      return res.status(200).end();
    }

    await sendMessage(chatId, MSG.default);

  } catch(e) {
    console.error('Bot error:', e.message);
    const chatId = req.body && req.body.message && req.body.message.chat && req.body.message.chat.id;
    if (chatId) {
      try { await sendMessage(chatId, 'Ошибка: ' + e.message); } catch(e2) {}
    }
  }
  return res.status(200).end();
};
