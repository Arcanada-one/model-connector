/** Concrete production module composition; source-only until isolated executor admission. */
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { ConnectorsService } from '../../src/connectors/connectors.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  OUTPUT_GUARD_CONFIG,
  type OutputGuardRuntimeConfig,
} from '../../src/connectors/output-guard/output-guard.middleware';
import { observeDiagnostic, type RawCase } from './df60-adapter';
import { classifyLocalGrounding } from './df60-grounding';

export const DIAGNOSTIC_GUARD_CONFIG: Readonly<OutputGuardRuntimeConfig> = Object.freeze({
  enabled: true,
  maxRetries: 0,
  timeoutMs: 1000,
});

export async function runComposedDiagnostic(
  fixture: RawCase,
  writer: PrismaService,
  apiKeyId: string,
  guardConfig: Readonly<OutputGuardRuntimeConfig> = DIAGNOSTIC_GUARD_CONFIG,
) {
  let moduleRef:
    | Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>
    | undefined;
  try {
    const observation = await observeDiagnostic(
      fixture,
      writer,
      async (observedWriter) => {
        moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(PrismaService)
          .useValue(observedWriter)
          .overrideProvider(OUTPUT_GUARD_CONFIG)
          .useValue({ ...guardConfig })
          .compile();
        await moduleRef.init();
        return moduleRef.get(ConnectorsService);
      },
      apiKeyId,
    );
    return {
      ...observation,
      guardRuntimeConfig: moduleRef
        ? { ...moduleRef.get<OutputGuardRuntimeConfig>(OUTPUT_GUARD_CONFIG) }
        : null,
      groundingObservation: fixture.request.output_format
        ? classifyLocalGrounding(fixture.request, observation.response.structured)
        : null,
    };
  } finally {
    await moduleRef?.close();
  }
}
