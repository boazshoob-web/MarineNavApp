import { authenticateRequest } from '../../lib/auth.mjs';

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const user = await authenticateRequest(req);
    if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    return res.status(200).json({ userId: user.userId, email: user.email });
}
