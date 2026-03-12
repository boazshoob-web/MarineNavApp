import * as jose from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

export async function createJwt(userId, email) {
    return await new jose.SignJWT({ sub: userId, email })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('30d')
        .setIssuedAt()
        .sign(JWT_SECRET);
}

export async function verifyJwt(token) {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET);
    return { userId: payload.sub, email: payload.email };
}

export async function authenticateRequest(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return null;
    }
    try {
        return await verifyJwt(auth.slice(7));
    } catch {
        return null;
    }
}
