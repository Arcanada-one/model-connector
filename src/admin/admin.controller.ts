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
import { ZodError } from 'zod';
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
    let data: ReturnType<typeof CreateKeySchema.parse>;
    try {
      data = CreateKeySchema.parse(body);
    } catch (error) {
      if (error instanceof ZodError) throw new BadRequestException(error.issues);
      throw error;
    }
    return this.adminService.createKey(data.name, data.rateLimit, data.policy);
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

  @Get(':id/policy')
  async getPolicy(@Param('id') id: string) {
    return this.adminService.getKeyPolicy(id);
  }

  @Get(':id/usage')
  async getUsage(@Param('id') id: string) {
    return this.adminService.getKeyUsage(id);
  }

  /**
   * A2-319 — change `rateLimit` of an existing key (requests per 60s window).
   * Body `{ rateLimit, actor, reason? }`; in force on the next request. The
   * response carries `previousRateLimit` so the caller's own record of the
   * change does not depend on having read the key first.
   */
  @Patch(':id/rate-limit')
  async setRateLimit(@Param('id') id: string, @Body() body: unknown, @Req() req: { ip?: string }) {
    let data: ReturnType<typeof SetKeyRateLimitSchema.parse>;
    try {
      data = SetKeyRateLimitSchema.parse(body);
    } catch (error) {
      if (error instanceof ZodError) throw new BadRequestException(error.issues);
      throw error;
    }
    return this.adminService.setKeyRateLimit(id, data.rateLimit, {
      actor: data.actor,
      reason: data.reason,
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
    let data: ReturnType<typeof SetKeyPolicySchema.parse>;
    try {
      data = SetKeyPolicySchema.parse(body);
    } catch (error) {
      if (error instanceof ZodError) throw new BadRequestException(error.issues);
      throw error;
    }
    return this.adminService.setKeyPolicy(id, data.policy);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('id') id: string) {
    await this.adminService.revokeKey(id);
  }
}
