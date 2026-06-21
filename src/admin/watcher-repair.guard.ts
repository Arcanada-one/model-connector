import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class WatcherRepairGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-watcher-repair-token'] as string | undefined;
    const expected = process.env.WATCHER_REPAIR_TOKEN;
    if (!expected || !token || token.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }
}
