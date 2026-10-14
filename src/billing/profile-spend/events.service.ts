import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PolicyService } from '../../policy/policy.service';
import { SqlProfileSpendStore, type SpendSql } from './store';
import { ProfileSpendError } from './plan';

@Injectable()
export class ProfileSpendEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyService,
  ) {}
  async read(clientKeyId: string, after: string, limit: number) {
    try {
      const policy = await this.policies.getPolicyForKey(clientKeyId);
      if (policy?.policyVersion !== 2 || !policy.profile || !policy.spend)
        throw new ProfileSpendError('profile_spend_unavailable');
      const sql = (client: Pick<PrismaService, '$queryRawUnsafe'>): SpendSql => ({
        query: async (text, values) => ({
          rows: await client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values),
        }),
      });
      const store = new SqlProfileSpendStore({
        ...sql(this.prisma),
        transaction: (fn) => this.prisma.$transaction((tx) => fn(sql(tx))),
      });
      return await store.readEvents(
        policy.profile.accountingBucket,
        policy.profile.id,
        after,
        limit,
      );
    } catch (error) {
      if (error instanceof ProfileSpendError) throw error;
      // Never expose driver/parser excerpts or connection credentials.
      throw new ProfileSpendError('profile_spend_read_unavailable');
    }
  }
}
