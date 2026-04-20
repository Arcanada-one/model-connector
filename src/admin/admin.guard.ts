import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-admin-token'] as string | undefined;
    const expected = process.env.ADMIN_TOKEN;

    if (!expected || !token) return false;
    if (token.length !== expected.length) return false;

    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }
}
