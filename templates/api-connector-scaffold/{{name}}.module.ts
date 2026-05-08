import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { {{NAME}}Connector } from './{{NAME_LOWER}}.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [{{NAME}}Connector],
})
export class {{NAME}}Module implements OnModuleInit {
  constructor(
    private readonly {{NAME_LOWER}}: {{NAME}}Connector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.{{NAME_LOWER}});
  }
}
