// Telegram webhook handler for carwash map bot
import { createClient } from '@supabase/supabase-js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAP_URL = process.env.MAP_URL || 'https://carwash-map.vercel.app';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
}

async function fetchPageText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await resp.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 8000);
  } catch (e) {
    return null;
  }
}

async function parseWithClaude(content, url) {
  const prompt = [
    'You are helping analyze Russian real estate listings for self-service car wash rental in Moscow.',
    'Extract data from the listing text and return ONLY valid JSON without markdown or explanations.',
    '',
    'Listing URL: ' + url,
    'Listing text:',
    '---',
    content.slice(0, 6000),
    '---',
    '',
    'Return this exact JSON:',
    '{',
    '  "title": "short object name in Russian",',
    '  "address": "full Moscow address in Russian",',
    '  "district": "district and okrug or null",',
    '  "metro": "nearest metro or null",',
    '  "area_m2": number or null,',
    '  "posts": number of car wash posts or null,',
    '  "rent_month": monthly rent in rubles as number or null,',
    '  "lease_years": lease term in years or null,',
    '  "has_equipment": true/false/null,',
    '  "access_247": true/false/null,',
    '  "parking": true/false/null,',
    '  "utilities_included": true/false/null,',
    '  "source": "avito" or "cian" or "manual",',
    '  "url": "' + url + '",',
    '  "comment": "1-2 sentence summary in Russian with key details",',
    '  "red_flags": ["array from: lease_under_5_years, area_under_200, posts_under_3, no_parking, no_access_247, needs_renovation, industrial_zone, low_ceiling, forbidden_use"],',
    '  "score": number 0-10',
    '}',
    '',
    'Score: 9-10 ready car wash 4+ posts in residential area, 7-8 good 500+m2, 5-6 promising, 3-4 needs check, 0-2 weak.',
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
  if (!response.ok) throw new Error(data.error?.message || 'Claude API error');
  const text = data.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse Claude response');
  return JSON.parse(jsonMatch[0]);
}

async function geocode(address) {
  try {
    const query = encodeURIComponent('Москва, ' + address);
    const resp = await fetch(
      `https://geocode-maps.yandex.ru/1.x/?apikey=f30a06ff-8f3e-45d8-8408-0d663acdbc1b&geocode=${query}&format=json&results=1`
    );
    const data = await resp.json();
    const pos = data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject?.Point?.pos;
    if (pos) {
      const [lon, lat] = pos.split(' ').map(Number);
      return { lat, lon };
    }
  } catch (e) {}
  return { lat: null, lon: null };
}

async function saveListing(parsed, addedBy) {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  let lat = null, lon = null;
  if (parsed.address) {
    const coords = await geocode(parsed.address);
    lat = coords.lat; lon = coords.lon;
  }
  const { data, error } = await sb.from('listings').insert({
    source: 'bot',
    url: parsed.url || null,
    title: parsed.title || parsed.address || 'Новое объявление',
    address: parsed.address || '',
    lat, lon,
    district: parsed.district || null,
    metro: parsed.metro || null,
    area_m2: parsed.area_m2 || null,
    posts: parsed.posts || null,
    rent_month: parsed.rent_month || null,
    lease_years: parsed.lease_years || null,
    has_equipment: parsed.has_equipment ?? null,
    access_247: parsed.access_247 ?? null,
    parking: parsed.parking ?? null,
    utilities_included: parsed.utilities_included ?? null,
    comment: parsed.comment || null,
    red_flags: parsed.red_flags || [],
    score: parsed.score || 0,
    status: 'new',
  }).select().single();
  if (error) throw new Error('Supabase error: ' + error.message);

  // Log to activity
  try {
    await sb.from('activity').insert({
      type: 'bot',
      user_name: addedBy,
      description: 'добавил через Telegram: "' + (parsed.address || 'объявление') + '"',
      listing_id: data.id,
    });
  } catch(e) {}

  return data;
}

function formatResult(parsed) {
  const scoreEmoji = parsed.score >= 7 ? '🟢' : parsed.score >= 3 ? '🟡' : '🔘';
  const rent = parsed.rent_month ? Math.round(parsed.rent_month / 1000) + 'к ₽/мес' : 'цена не указана';
  const area = parsed.area_m2 ? parsed.area_m2 + ' м²' : '';
  const posts = parsed.posts ? parsed.posts + ' поста' : '';
  const equip = parsed.has_equipment === true ? '✅ с оборудованием' : parsed.has_equipment === false ? '🔧 без оборудования' : '';
  const flags = parsed.red_flags?.length ? '\n\n⚠️ <b>Флаги:</b> ' + parsed.red_flags.join(', ') : '';

  return [
    scoreEmoji + ' <b>Score: ' + parsed.score + '/10</b> — добавлено на карту',
    '',
    '📍 <b>' + parsed.address + '</b>',
    parsed.district ? '📌 ' + parsed.district : '',
    parsed.metro ? '🚇 ' + parsed.metro : '',
    '',
    [area, posts, rent, equip].filter(Boolean).join(' · '),
    '',
    parsed.comment ? '💬 ' + parsed.comment : '',
    flags,
    '',
    '🗺 <a href="' + MAP_URL + '">Открыть карту</a>',
    parsed.url ? '🔗 <a href="' + parsed.url + '">Объявление</a>' : '',
  ].filter(s => s !== null && s !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}

const HELP_TEXT = [
  '📋 <b>Как добавить объявление на карту:</b>',
  '',
  '<b>Способ 1 — прислать ссылку</b>',
  '1. Найди объявление на Авито или Циан',
  '2. Скопируй ссылку из адресной строки',
  '3. Отправь её мне',
  '4. Я попробую прочитать страницу и добавлю объявление',
  '',
  '<b>Способ 2 — прислать текст (надёжнее)</b>',
  '1. Открой объявление на Авито или Циан',
  '2. Выдели весь текст на странице (Ctrl+A / Cmd+A)',
  '3. Скопируй (Ctrl+C / Cmd+C)',
  '4. Вставь и отправь мне',
  '',
  '<b>Что я извлекаю автоматически:</b>',
  '• Адрес и координаты',
  '• Площадь, количество постов',
  '• Аренда и срок договора',
  '• Наличие оборудования',
  '• Район и метро',
  '• Оценка привлекательности (0-10)',
  '',
  '🗺 <a href="' + MAP_URL + '">Открыть карту</a>',
  '',
  'Команды: /start — начало, /help — эта справка',
].join('\n');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end();

  try {
    const update = req.body;
    const message = update?.message;
    if (!message) return res.status(200).end();

    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const userName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Пользователь';

    // Commands
    if (text === '/start') {
      await sendMessage(chatId,
        '👋 Привет, ' + userName + '!\n\n' +
        'Я добавляю объявления об аренде под автомойку самообслуживания на карту команды.\n\n' +
        HELP_TEXT
      );
      return res.status(200).end();
    }

    if (text === '/help') {
      await sendMessage(chatId, HELP_TEXT);
      return res.status(200).end();
    }

    // Check for URL
    const urlMatch = text.match(/https?:\/\/[^\s]+/);

    if (urlMatch) {
      const url = urlMatch[0];
      await sendMessage(chatId, '⏳ Читаю объявление...');
      const pageText = await fetchPageText(url);

      if (!pageText || pageText.length < 200) {
        await sendMessage(chatId,
          '⚠️ Не удалось прочитать страницу автоматически — Авито/Циан заблокировали запрос.\n\n' +
          '<b>Попробуй Способ 2:</b>\n' +
          '1. Открой объявление в браузере\n' +
          '2. Выдели весь текст (Cmd+A)\n' +
          '3. Скопируй (Cmd+C)\n' +
          '4. Отправь текст мне сюда'
        );
        return res.status(200).end();
      }

      await sendMessage(chatId, '🤖 Анализирую через Claude AI...');
      const parsed = await parseWithClaude(pageText, url);
      const saved = await saveListing(parsed, userName);
      await sendMessage(chatId, formatResult(parsed));
      return res.status(200).end();
    }

    // Long text — try to parse as listing content
    if (text.length > 200) {
      await sendMessage(chatId, '🤖 Анализирую текст через Claude AI...');
      const urlInText = text.match(/https?:\/\/(?:www\.)?(?:avito|cian)\.ru\/[^\s]*/);
      const listingUrl = urlInText ? urlInText[0] : '';
      const parsed = await parseWithClaude(text, listingUrl);
      const saved = await saveListing(parsed, userName);
      await sendMessage(chatId, formatResult(parsed));
      return res.status(200).end();
    }

    // Short message — show help
    await sendMessage(chatId,
      'Отправь мне ссылку на объявление или скопированный текст страницы.\n\n' +
      '/help — подробная инструкция'
    );

  } catch (e) {
    console.error(e);
    const chatId = req.body?.message?.chat?.id;
    if (chatId) {
      await sendMessage(chatId,
        '❌ Ошибка при обработке: ' + e.message + '\n\n' +
        'Попробуй прислать текст объявления вместо ссылки.'
      );
    }
  }

  return res.status(200).end();
}
