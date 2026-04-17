import { Body, Controller, Get, Param, Post, Req, UsePipes } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  ExecuteRequestDto,
  executeRequestSchema,
  PerConnectorExecuteDto,
  perConnectorExecuteSchema,
} from './dto/execute.dto';

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
  @UsePipes(new ZodValidationPipe(perConnectorExecuteSchema))
  async executePerConnector(
    @Param('name') name: string,
    @Body() body: PerConnectorExecuteDto,
    @Req() req: any,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    return this.connectorsService.execute(name, body, apiKeyId);
  }

  @Post('execute')
  @UsePipes(new ZodValidationPipe(executeRequestSchema))
  async executeUniversal(@Body() body: ExecuteRequestDto, @Req() req: any) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const { connector, ...request } = body;
    return this.connectorsService.execute(connector, request, apiKeyId);
  }
}
