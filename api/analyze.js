// Vercel Serverless Function — proxies Anthropic API
// The ANTHROPIC_API_KEY env var is set in Vercel dashboard (never exposed to browser)

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text field required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a financial data parser. Extract structured debt/income data from CSV/text and return ONLY valid JSON, no markdown. Schema: {"summary":"string","monthlyIncome":number,"incomeSource":"string","creditCards":[{"name":"string","balance":number,"rate":number,"min":number}],"loans":[{"name":"string","balance":number,"rate":number,"min":number}],"mortgage":{"balance":number,"payment":number,"rate":number}|null,"trimmableMonthly":number,"insights":["string"],"opportunities":["string"]}. Estimate APR at 20-27% for cards if not shown. Flag all debt accounts.`,
        messages: [
          {
            role: 'user',
            content: `Parse this financial data:\n\n${text.slice(0, 8000)}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Anthropic proxy error:', err);
    return res.status(500).json({ error: 'AI analysis failed' });
  }
}
