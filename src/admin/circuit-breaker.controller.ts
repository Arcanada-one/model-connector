import {
  BadRequestException,
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AdminGuard } from './admin.guard';
import { ResetCircuitBreakerSchema } from './dto';
import { ConnectorsService } from '../connectors/connectors.service';
import { ZodError } from 'zod';

@Controller('admin/circuit-breaker')
@UseGuards(AdminGuard)
@Public()
export class CircuitBreakerAdminController {
  constructor(private readonly connectorsService: ConnectorsService) {}

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  reset(@Body() body: unknown) {
    let data: ReturnType<typeof ResetCircuitBreakerSchema.parse>;
    try {
      // Preserve the documented bodyless reset-all operation. Nest supplies
      // `undefined` when a POST has no JSON body, while Zod's object schema
      // expects an object.
      data = ResetCircuitBreakerSchema.parse(body ?? {});
    } catch (error) {
      if (error instanceof ZodError) throw new BadRequestException(error.issues);
      throw error;
    }

    const results = this.connectorsService.resetCircuitBreaker(data.connector, data.model);

    return {
      reset: results,
      count: results.length,
    };
  }
}
