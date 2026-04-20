import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ConnectorsService } from './connectors.service';
import { ConnectorResponse } from './interfaces/connector.interface';
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

const HTTP_ERROR_STATUS: Record<string, HttpStatus> = {
  queue_timeout: HttpStatus.SERVICE_UNAVAILABLE,
  circuit_open: HttpStatus.SERVICE_UNAVAILABLE,
  auth_error: HttpStatus.SERVICE_UNAVAILABLE,
  binary_not_found: HttpStatus.SERVICE_UNAVAILABLE,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
};

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
    const response = await this.connectorsService.execute(name, body, apiKeyId);
    return this.mapResponseStatus(response);
  }

  @Post('execute')
  async executeUniversal(
    @Body(new ZodValidationPipe(executeRequestSchema)) body: ExecuteRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const { connector, ...request } = body;
    const response = await this.connectorsService.execute(connector, request, apiKeyId);
    return this.mapResponseStatus(response);
  }

  private mapResponseStatus(response: ConnectorResponse): ConnectorResponse {
    const errorType = response.error?.type;
    if (errorType && errorType in HTTP_ERROR_STATUS) {
      throw new HttpException(response, HTTP_ERROR_STATUS[errorType]);
    }
    return response;
  }
}
