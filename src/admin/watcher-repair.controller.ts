import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../auth/public.decorator';
import { ConnectorsService } from '../connectors/connectors.service';
import { WatcherRepairGuard } from './watcher-repair.guard';

const WatcherResetSchema = z
  .object({
    connector: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
  })
  .strict();

@Controller('internal/watcher/circuit-breaker')
@UseGuards(WatcherRepairGuard)
@Public()
export class WatcherRepairController {
  constructor(private readonly connectorsService: ConnectorsService) {}

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  reset(@Body() body: unknown) {
    const parsed = WatcherResetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid scoped watcher reset request');
    const reset = this.connectorsService.resetCircuitBreaker(
      parsed.data.connector,
      parsed.data.model,
    );
    return { reset, count: reset.length };
  }
}
