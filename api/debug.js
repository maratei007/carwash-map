module.exports = async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = req.query.chat_id;

  // Test getMe
  let getMeResult = {};
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/getMe');
    getMeResult = await r.json();
  } catch(e) { getMeResult = { error: e.message }; }

  // Test sendMessage if chat_id provided
  let sendResult = 'provide ?chat_id=YOUR_CHAT_ID to test';
  if (chatId) {
    try {
      const body = JSON.stringify({ chat_id: parseInt(chatId), text: 'Test from debug v1' });
      const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });
      sendResult = await r.json();
    } catch(e) { sendResult = { error: e.message }; }
  }

  return res.status(200).json({
    token_length: token.length,
    token_preview: token.slice(0,15) + '...',
    getMe: getMeResult,
    sendMessage: sendResult,
  });
};
