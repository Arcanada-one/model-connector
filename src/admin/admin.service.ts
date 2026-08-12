import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getConfig } from '../config/env.schema';
// CONN-1665 — per-key access policy (validated by the controller BEFORE it gets here).
import { PolicyService } from '../policy/policy.service';
import type { ApiKeyPolicy } from '../policy/policy.schema';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    // CONN-1665 — optional so pre-existing manual constructions keep working;
    // the module provides the real singleton (shared with the choke point) so
    // policy writes invalidate the 60s read cache immediately.
    @Optional() private readonly policyService?: PolicyService,
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
    await this.prisma.apiKey.update({
      where: { id },
      data: { policy: policy === null ? Prisma.DbNull : (policy as Prisma.InputJsonValue) },
    });
    this.policyService?.invalidateKey(id);
    return { id };
  }
}
