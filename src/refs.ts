import crypto from 'crypto';

export function symbolRef(symbolId: string) {
    return crypto.createHash('sha1').update(symbolId).digest('hex').slice(0, 10);
}
