module.exports = async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const host = req.headers.host;
  const webhookUrl = `https://${host}/api/bot`;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const data = await response.json();
  return res.status(200).json({ webhook_url: webhookUrl, telegram_response: data });
};
