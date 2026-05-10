import { Module, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ImageGenerationService } from './image-generation.service';
import { ImageJobProcessor, IMAGE_GEN_SVC } from './jobs/image-job.processor';
import { ImageJobController } from './jobs/image-job.controller';
import { validateCapabilities } from './capabilities';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'image-jobs',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200,
        attempts: 2,
      },
    }),
  ],
  providers: [
    ImageGenerationService,
    { provide: IMAGE_GEN_SVC, useExisting: ImageGenerationService },
    ImageJobProcessor,
  ],
  controllers: [ImageJobController],
  exports: [ImageGenerationService],
})
export class ImageGenerationModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImageGenerationModule.name);

  onApplicationBootstrap(): void {
    // Boot-time validation of IMAGE_CAPABILITIES Zod schema
    try {
      validateCapabilities();
      this.logger.log('IMAGE_CAPABILITIES Zod validation passed');
    } catch (err) {
      this.logger.error('IMAGE_CAPABILITIES validation failed — fix capabilities.ts!', err);
      throw err; // Crash fast — bad capability data is a deploy error
    }
  }
}
