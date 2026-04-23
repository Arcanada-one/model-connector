import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AdminGuard } from './admin.guard';
import { ResetCircuitBreakerSchema } from './dto';
import { ConnectorsService } from '../connectors/connectors.service';

@Controller('admin/circuit-breaker')
@UseGuards(AdminGuard)
@Public()
export class CircuitBreakerAdminController {
  constructor(private readonly connectorsService: ConnectorsService) {}

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  reset(@Body() body: unknown) {
    const parsed = ResetCircuitBreakerSchema.safeParse(body);
    const connector = parsed.success ? parsed.data.connector : undefined;
    const model = parsed.success ? parsed.data.model : undefined;

    const results = this.connectorsService.resetCircuitBreaker(connector, model);

    return {
      reset: results,
      count: results.length,
    };
  }
}
