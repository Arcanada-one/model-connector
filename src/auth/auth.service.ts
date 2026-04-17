import { Injectable } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async validateKey(rawKey: string): Promise<{ id: string; name: string } | null> {
    const keys = await this.prisma.apiKey.findMany({ where: { active: true } });
    for (const key of keys) {
      const match = await compare(rawKey, key.keyHash);
      if (match) {
        return { id: key.id, name: key.name };
      }
    }
    return null;
  }
}
