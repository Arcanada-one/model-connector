import { forwardRef, Inject, Module } from '@nestjs/common';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';
import { FireworksConnector } from './fireworks.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [FireworksConnector],
})
export class FireworksModule {
  constructor(
    connector: FireworksConnector,
    @Inject(forwardRef(() => ConnectorsService)) registry: ConnectorsService,
  ) {
    registry.register(connector);
  }
}
