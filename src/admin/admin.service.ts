import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { hash } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { getConfig } from '../config/env.schema';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async createKey(name: string, rateLimit?: number): Promise<{ id: string; name: string; key: string }> {
    const raw = `mc-${randomBytes(16).toString('hex')}`;
    const keyHash = await hash(raw, getConfig().API_KEY_SALT_ROUNDS);
    const record = await this.prisma.apiKey.create({
      data: { name, keyHash, rateLimit: rateLimit ?? 60 },
    });
    return { id: record.id, name: record.name, key: raw };
  }

  async listKeys(): Promise<Array<{ id: string; name: string; rateLimit: number; active: boolean; createdAt: Date }>> {
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
}
