import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ConnectorsService } from './connectors.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  ExecuteRequestDto,
  executeRequestSchema,
  PerConnectorExecuteDto,
  perConnectorExecuteSchema,
} from './dto/execute.dto';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

@Controller()
export class ConnectorsController {
  constructor(private readonly connectorsService: ConnectorsService) {}

  @Get('connectors')
  async listConnectors() {
    return this.connectorsService.listAll();
  }

  @Get('connectors/:name/status')
  async getStatus(@Param('name') name: string) {
    return this.connectorsService.getStatus(name);
  }

  @Post('connectors/:name/execute')
  async executePerConnector(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(perConnectorExecuteSchema)) body: PerConnectorExecuteDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    return this.connectorsService.execute(name, body, apiKeyId);
  }

  @Post('execute')
  async executeUniversal(
    @Body(new ZodValidationPipe(executeRequestSchema)) body: ExecuteRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const { connector, ...request } = body;
    return this.connectorsService.execute(connector, request, apiKeyId);
  }
}
