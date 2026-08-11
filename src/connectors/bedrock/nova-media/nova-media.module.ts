import { Inject, Module, OnModuleInit, forwardRef } from '@nestjs/common';
import type { IConnector } from '../../interfaces/connector.interface';
import { ConnectorsModule } from '../../connectors.module';
import { ConnectorsService } from '../../connectors.service';
import { NovaMediaConnector } from './nova-media.connector';

interface ConnectorRegistry {
  register(connector: IConnector): void;
}

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [NovaMediaConnector],
  exports: [NovaMediaConnector],
})
export class NovaMediaModule implements OnModuleInit {
  constructor(
    private readonly connector: NovaMediaConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly registry: ConnectorRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.connector);
  }
}
