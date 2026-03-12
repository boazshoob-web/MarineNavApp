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

    if (passphrase.length < 4) {
        return res.status(400).json({ error: 'Passphrase must be at least 4 characters' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    try {
        // Check if user already exists
        const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail}`;
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Account already exists. Please sign in.' });
        }

        const passwordHash = await bcrypt.hash(passphrase, 10);

        const rows = await sql`
            INSERT INTO users (email, password_hash)
            VALUES (${normalizedEmail}, ${passwordHash})
            RETURNING id, email
        `;

        const user = rows[0];
        const jwt = await createJwt(user.id, user.email);

        return res.status(201).json({ jwt, email: user.email });
    } catch (err) {
        console.error('Register error:', err);
        return res.status(500).json({ error: 'Registration failed' });
    }
}
