import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { CreateKeySchema } from './dto';

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
    return this.adminService.createKey(result.data.name, result.data.rateLimit);
  }

  @Get()
  async list() {
    return this.adminService.listKeys();
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('id') id: string) {
    await this.adminService.revokeKey(id);
  }
}
