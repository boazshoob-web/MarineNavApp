import sql from '../../lib/db.mjs';
import bcrypt from 'bcryptjs';
import { createJwt } from '../../lib/auth.mjs';

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email, passphrase } = req.body || {};

    if (!email || !passphrase) {
        return res.status(400).json({ error: 'Email and passphrase are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    try {
        const rows = await sql`SELECT id, email, password_hash FROM users WHERE email = ${normalizedEmail}`;

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or passphrase' });
        }

        const user = rows[0];
        const valid = await bcrypt.compare(passphrase, user.password_hash);

        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or passphrase' });
        }

        const jwt = await createJwt(user.id, user.email);

        return res.status(200).json({ jwt, email: user.email });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Login failed' });
    }
}
