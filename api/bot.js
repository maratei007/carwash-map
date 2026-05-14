const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAP_URL = process.env.MAP_URL || 'https://carwash-map.vercel.app';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function fetchPageText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
    const html = await resp.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,8000);
  } catch(e) { return null; }
}

async function parseWithClaude(content, url) {
  const prompt = 'You are helping analyze Russian real estate listings for self-service car wash rental in Moscow.\nExtract data and return ONLY valid JSON:\n{"title":"...","address":"...","district":null,"metro":null,"area_m2":null,"posts":null,"rent_month":null,"lease_years":null,"has_equipment":null,"access_247":null,"parking":null,"utilities_included":null,"source":"avito","url":"' + url + '","comment":"...","red_flags":[],"score":0}\nListing:\n' + content.slice(0,5000);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || 'Claude error');
  const match = data.content[0].text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function geocode(address) {
  try {
    const q = encodeURIComponent('Москва, ' + address);
    const resp = await fetch(`https://geocode-maps.yandex.ru/1.x/?apikey=f30a06ff-8f3e-45d8-8408-0d663acdbc1b&geocode=${q}&format=json&results=1`);
    const data = await resp.json();
    const pos = data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject?.Point?.pos;
    if (pos) { const [lon, lat] = pos.split(' ').map(Number); return { lat, lon }; }
  } catch(e) {}
  return { lat: null, lon: null };
}

async function saveListing(parsed, addedBy) {
  const coords = parsed.address ? await geocode(parsed.address) : { lat: null, lon: null };
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/listings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      source: 'bot', url: parsed.url || null,
      title: parsed.title || parsed.address || 'Объявление',
      address: parsed.address || '',
      lat: coords.lat, lon: coords.lon,
      district: parsed.district || null, metro: parsed.metro || null,
      area_m2: parsed.area_m2 || null, posts: parsed.posts || null,
      rent_month: parsed.rent_month || null, lease_years: parsed.lease_years || null,
      has_equipment: parsed.has_equipment ?? null,
      access_247: parsed.access_247 ?? null,
      parking: parsed.parking ?? null,
      utilities_included: parsed.utilities_included ?? null,
      comment: parsed.comment || null,
      red_flags: parsed.red_flags || [],
      score: parsed.score || 0, status: 'new',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Supabase error: ' + JSON.stringify(data));

  const saved = Array.isArray(data) ? data[0] : data;

  // Log activity
  await fetch(`${SUPABASE_URL}/rest/v1/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify({ type: 'bot', user_name: addedBy, description: 'добавил через Telegram: "' + (parsed.address || 'объявление') + '"', listing_id: saved?.id || null }),
  }).catch(() => {});

  return saved;
}

const HELP_TEXT = `📋 <b>Как добавить объявление на карту:</b>

<b>Способ 1 — прислать ссылку</b>
1. Найди объявление на Авито или Циан
2. Скопируй ссылку из адресной строки
3. Отправь её мне

<b>Способ 2 — прислать текст (надёжнее)</b>
1. Открой объявление в браузере
2. Выдели весь текст (Ctrl+A / Cmd+A)
3. Скопируй (Ctrl+C / Cmd+C)
4. Вставь и отправь мне

<b>Что я извлекаю автоматически:</b>
• Адрес и координаты
• Площадь, количество постов
• Аренда и срок договора
• Наличие оборудования
• Район и метро
• Оценка привлекательности (0-10)

🗺 <a href="${MAP_URL}">Открыть карту</a>

Команды: /start — начало, /help — справка`;

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, status: 'bot is running' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const update = req.body;
    const message = update?.message;
    if (!message) return res.status(200).end();

    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const userName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Пользователь';

    if (text === '/start') {
      await sendMessage(chatId, '👋 Привет, ' + userName + '!\n\nЯ добавляю объявления об аренде под автомойку самообслуживания на карту команды.\n\n' + HELP_TEXT);
      return res.status(200).end();
    }

    if (text === '/help') {
      await sendMessage(chatId, HELP_TEXT);
      return res.status(200).end();
    }

    const urlMatch = text.match(/https?:\/\/[^\s]+/);

    if (urlMatch) {
      const url = urlMatch[0];
      await sendMessage(chatId, '⏳ Читаю объявление...');
      const pageText = await fetchPageText(url);
      if (!pageText || pageText.length < 200) {
        await sendMessage(chatId, '⚠️ Не удалось прочитать страницу — Авито/Циан заблокировали запрос.\n\n<b>Попробуй Способ 2:</b>\n1. Открой объявление в браузере\n2. Выдели весь текст (Cmd+A)\n3. Скопируй (Cmd+C)\n4. Отправь текст мне');
        return res.status(200).end();
      }
      await sendMessage(chatId, '🤖 Анализирую через Claude AI...');
      const parsed = await parseWithClaude(pageText, url);
      await saveListing(parsed, userName);
      const scoreEmoji = parsed.score >= 7 ? '🟢' : parsed.score >= 3 ? '🟡' : '🔘';
      const rent = parsed.rent_month ? Math.round(parsed.rent_month/1000) + 'к ₽/мес' : 'цена не указана';
      await sendMessage(chatId, scoreEmoji + ' <b>Score: ' + parsed.score + '/10</b> — добавлено на карту!\n\n📍 <b>' + (parsed.address || '—') + '</b>\n' + (parsed.metro ? '🚇 ' + parsed.metro + '\n' : '') + (parsed.area_m2 ? '📐 ' + parsed.area_m2 + ' м²  ' : '') + rent + '\n\n' + (parsed.comment || '') + '\n\n🗺 <a href="' + MAP_URL + '">Открыть карту</a>');
      return res.status(200).end();
    }

    if (text.length > 200) {
      await sendMessage(chatId, '🤖 Анализирую текст через Claude AI...');
      const urlInText = text.match(/https?:\/\/(?:www\.)?(?:avito|cian)\.ru\/[^\s]*/);
      const parsed = await parseWithClaude(text, urlInText ? urlInText[0] : '');
      await saveListing(parsed, userName);
      const scoreEmoji = parsed.score >= 7 ? '🟢' : parsed.score >= 3 ? '🟡' : '🔘';
      const rent = parsed.rent_month ? Math.round(parsed.rent_month/1000) + 'к ₽/мес' : 'цена не указана';
      await sendMessage(chatId, scoreEmoji + ' <b>Score: ' + parsed.score + '/10</b> — добавлено на карту!\n\n📍 <b>' + (parsed.address || '—') + '</b>\n' + (parsed.metro ? '🚇 ' + parsed.metro + '\n' : '') + (parsed.area_m2 ? '📐 ' + parsed.area_m2 + ' м²  ' : '') + rent + '\n\n' + (parsed.comment || '') + '\n\n🗺 <a href="' + MAP_URL + '">Открыть карту</a>');
      return res.status(200).end();
    }

    await sendMessage(chatId, 'Отправь ссылку на объявление или скопированный текст страницы.\n\n/help — инструкция');

  } catch(e) {
    console.error('Bot error:', e);
    const chatId = req.body?.message?.chat?.id;
    if (chatId) await sendMessage(chatId, '❌ Ошибка: ' + e.message);
  }

  return res.status(200).end();
};
