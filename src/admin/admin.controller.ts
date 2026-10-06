import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { CreateKeySchema, SetKeyPolicySchema, SetKeyRateLimitSchema } from './dto';

@Controller('admin/keys')
@UseGuards(AdminGuard)
@Public()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const result = CreateKeySchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return this.adminService.createKey(result.data.name, result.data.rateLimit, result.data.policy);
  }

  @Get()
  async list() {
    return this.adminService.listKeys();
  }

  /** A2-319 — one key, secret-free: id, name, rateLimit, active, createdAt. */
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.adminService.getKey(id);
  }

  /**
   * A2-319 — change `rateLimit` of an existing key (requests per 60s window).
   * Body `{ rateLimit, actor, reason? }`; in force on the next request. The
   * response carries `previousRateLimit` so the caller's own record of the
   * change does not depend on having read the key first.
   */
  @Patch(':id/rate-limit')
  async setRateLimit(@Param('id') id: string, @Body() body: unknown, @Req() req: { ip?: string }) {
    const result = SetKeyRateLimitSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return this.adminService.setKeyRateLimit(id, result.data.rateLimit, {
      actor: result.data.actor,
      reason: result.data.reason,
      sourceIp: req.ip,
    });
  }

  /**
   * CONN-1665 — set/replace a key's access policy (body `{ policy: {...} }`);
   * `{ policy: null }` clears it. Zod write-time validation — malformed
   * policies (wrong shape, non-env-name providerKeys values, providers
   * without override support) are rejected before Prisma.
   */
  @Patch(':id/policy')
  async setPolicy(@Param('id') id: string, @Body() body: unknown) {
    const result = SetKeyPolicySchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return this.adminService.setKeyPolicy(id, result.data.policy);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('id') id: string) {
    await this.adminService.revokeKey(id);
  }
}
