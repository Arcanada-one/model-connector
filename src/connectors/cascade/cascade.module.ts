import { Module } from '@nestjs/common';
import { CascadeRouterService } from './cascade-router.service';

@Module({
  providers: [CascadeRouterService],
  exports: [CascadeRouterService],
})
export class CascadeModule {}
