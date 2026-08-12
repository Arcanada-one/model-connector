import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getConfig } from '../config/env.schema';
// CONN-1665 — per-key access policy (validated by the controller BEFORE it gets here).
import { PolicyService } from '../policy/policy.service';
import type { ApiKeyPolicy } from '../policy/policy.schema';
// CONN-1668 — flush the verified-key cache on key create/revoke.
import { AuthService } from '../auth/auth.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    // CONN-1665 — optional so pre-existing manual constructions keep working;
    // the module provides the real singleton (shared with the choke point) so
    // policy writes invalidate the 60s read cache immediately.
    @Optional() private readonly policyService?: PolicyService,
    // CONN-1668 — optional AuthService so create/revoke flush the verified-key
    // cache immediately (a revoked key must stop authenticating, and a freshly
    // created key must not be shadowed by a negative-cache entry).
    @Optional() private readonly authService?: AuthService,
  ) {}

  async createKey(
    name: string,
    rateLimit?: number,
    policy?: ApiKeyPolicy,
  ): Promise<{ id: string; name: string; key: string }> {
    const raw = `mc-${randomBytes(16).toString('hex')}`;
    const keyHash = await hash(raw, getConfig().API_KEY_SALT_ROUNDS);
    const record = await this.prisma.apiKey.create({
      data: {
        name,
        keyHash,
        rateLimit: rateLimit ?? 60,
        // CONN-1665 — already Zod-validated at the controller (write-time gate).
        ...(policy !== undefined ? { policy: policy as Prisma.InputJsonValue } : {}),
      },
    });
    this.authService?.flushVerifyCache();
    return { id: record.id, name: record.name, key: raw };
  }

  async listKeys(): Promise<
    Array<{ id: string; name: string; rateLimit: number; active: boolean; createdAt: Date }>
  > {
    return this.prisma.apiKey.findMany({
      select: { id: true, name: true, rateLimit: true, active: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeKey(id: string): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw new NotFoundException(`Key ${id} not found`);
    await this.prisma.apiKey.update({ where: { id }, data: { active: false } });
    this.authService?.flushVerifyCache();
  }

  /**
   * CONN-1665 — set/replace (or clear, with null) the access policy of a key.
   * The controller Zod-validates the policy BEFORE this call — same write-time
   * gate as key creation. Invalidate the PolicyService read cache so the new
   * policy takes effect immediately, not after the 60s TTL.
   */
  async setKeyPolicy(id: string, policy: ApiKeyPolicy | null): Promise<{ id: string }> {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw new NotFoundException(`Key ${id} not found`);
    // CONN-1674 — a read-only showcase key backs a PUBLIC catalog surface and
    // MUST see the full catalog. Reject any policy that narrows its view
    // (provider subset or a non-'all' model restriction) BEFORE it can silently
    // collapse the public page, as free-only did (998→33). Clearing the policy,
    // or a bare {policyVersion:1} with no restriction, stays allowed.
    if (policy !== null && this.isShowcaseKey(id) && AdminService.policyNarrowsCatalog(policy)) {
      throw new BadRequestException(
        `Key ${id} is a read-only showcase key (SHOWCASE_KEY_IDS): its policy must ` +
          `not restrict providers or models — a narrowing policy would silently ` +
          `collapse the public catalog. Clear the policy or leave it unrestricted.`,
      );
    }
    await this.prisma.apiKey.update({
      where: { id },
      data: { policy: policy === null ? Prisma.DbNull : (policy as Prisma.InputJsonValue) },
    });
    this.policyService?.invalidateKey(id);
    return { id };
  }

  /** CONN-1674 — is `id` in the SHOWCASE_KEY_IDS allowlist? Defensive getConfig
   * (matches the getCatalog convention): an unvalidated env in unit context
   * yields no showcase keys rather than throwing. */
  private isShowcaseKey(id: string): boolean {
    let raw: string;
    try {
      raw = getConfig().SHOWCASE_KEY_IDS;
    } catch {
      return false;
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(id);
  }

  /** CONN-1674 — a policy narrows the catalog when it restricts providers to a
   * subset or restricts models to anything other than 'all'. */
  static policyNarrowsCatalog(policy: ApiKeyPolicy): boolean {
    if (policy.providers !== undefined) return true;
    if (policy.models !== undefined && policy.models.mode !== 'all') return true;
    return false;
  }
}
