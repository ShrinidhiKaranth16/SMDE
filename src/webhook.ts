import axios from 'axios';
import { createHmac } from 'crypto';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change_me_in_production';

export async function deliverWebhook(url: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  await axios.post(url, payload, {
    headers: {
      'content-type': 'application/json',
      'x-smde-timestamp': timestamp,
      'x-smde-signature': `sha256=${signature}`,
    },
    timeout: 10000,
  });
}
