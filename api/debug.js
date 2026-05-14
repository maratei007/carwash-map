module.exports = async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN || 'NOT SET';
  const supabaseUrl = process.env.SUPABASE_URL || 'NOT SET';
  const supabaseKey = process.env.SUPABASE_KEY || 'NOT SET';
  const anthropicKey = process.env.ANTHROPIC_API_KEY || 'NOT SET';
  const mapUrl = process.env.MAP_URL || 'NOT SET';

  // Test Telegram token
  let telegramTest = 'not tested';
  try {
    const resp = await fetch('https://api.telegram.org/bot' + token + '/getMe');
    const data = await resp.json();
    telegramTest = data.ok ? 'OK: @' + data.result.username : 'FAIL: ' + JSON.stringify(data);
  } catch(e) {
    telegramTest = 'ERROR: ' + e.message;
  }

  return res.status(200).json({
    env: {
      TELEGRAM_BOT_TOKEN: token.slice(0,10) + '...' + token.slice(-4) + ' (length: ' + token.length + ')',
      SUPABASE_URL: supabaseUrl.slice(0,30) + '...',
      SUPABASE_KEY: supabaseKey.slice(0,20) + '... (length: ' + supabaseKey.length + ')',
      ANTHROPIC_API_KEY: anthropicKey === 'NOT SET' ? 'NOT SET' : 'SET (length: ' + anthropicKey.length + ')',
      MAP_URL: mapUrl,
    },
    telegram_test: telegramTest,
  });
};
