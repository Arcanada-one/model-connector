import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  ConnectorRequest,
  ConnectorResponse,
  IConnector,
} from '../connectors/interfaces/connector.interface';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCliConnector } from '../connectors/base-cli.connector';
export interface ConnectorJobData {
  connectorName: string;
  request: ConnectorRequest;
  apiKeyId: string;
}

@Processor('connector-jobs')
export class ConnectorJobProcessor extends WorkerHost {
  private readonly logger = new Logger(ConnectorJobProcessor.name);
  private connectors = new Map<string, IConnector>();

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  registerConnector(connector: IConnector) {
    this.connectors.set(connector.name, connector);
  }

  async process(job: Job<ConnectorJobData>): Promise<ConnectorResponse> {
    const { connectorName, request, apiKeyId } = job.data;
    const connector = this.connectors.get(connectorName);

    if (!connector) {
      throw new Error(`Connector "${connectorName}" not registered`);
    }

    this.logger.log(`Processing job ${job.id} for connector ${connectorName}`);
    const response = await connector.execute(request);

    await this.logRequest(response, request, apiKeyId);

    return response;
  }

  private async logRequest(
    response: ConnectorResponse,
    request: ConnectorRequest,
    apiKeyId: string,
  ) {
    try {
      await this.prisma.request.create({
        data: {
          connector: response.connector,
          model: response.model,
          promptHash: BaseCliConnector.hashPrompt(request.prompt),
          promptLength: request.prompt.length,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          costUsd: response.usage.costUsd,
          latencyMs: response.latencyMs,
          status: response.status,
          errorType: response.error?.type,
          errorMessage: response.error?.message?.slice(0, 500),
          apiKeyId,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to log request: ${err}`);
    }
  }
}
